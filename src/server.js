import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_ADMIN_BODY_BYTES = 64 * 1024;

const settings = {
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
  relayApiKey: process.env.RELAY_API_KEY || '',
  modelAllowlist: csv(process.env.MODEL_ALLOWLIST || ''),
  allowedOrigins: csv(process.env.ALLOWED_ORIGINS || ''),
  maxBodyBytes: numberEnv('MAX_BODY_BYTES', 10 * 1024 * 1024),
  upstreamTimeoutMs: numberEnv('UPSTREAM_TIMEOUT_MS', 300_000),
};
const sessions = new Map();
const loginAttempts = new Map();
const startedAt = Date.now();
const metrics = { requests: 0, errors: 0, recent: [] };

function csv(value) { return value.split(',').map((s) => s.trim()).filter(Boolean); }
function numberEnv(key, fallback) { const n = Number(process.env[key]); return Number.isFinite(n) && n > 0 ? n : fallback; }
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers });
  res.end(body);
}
function errorJson(res, status, type, message, headers = {}) {
  return json(res, status, { error: { type, message } }, headers);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}
function sessionFor(req) {
  const id = cookies(req).relay_session;
  const session = id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return session;
}
function requireAdmin(req, res, csrf = false) {
  const session = sessionFor(req);
  if (!session) { errorJson(res, 401, 'authentication_error', '请先登录管理后台。'); return null; }
  if (csrf && !safeEqual(req.headers['x-csrf-token'], session.csrf)) {
    errorJson(res, 403, 'csrf_error', '安全校验失败，请刷新页面后重试。');
    return null;
  }
  return session;
}
async function readJson(req, limit = MAX_ADMIN_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) { const error = new Error('body_too_large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { const error = new Error('invalid_json'); error.status = 400; throw error; }
}
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > settings.maxBodyBytes) { const error = new Error('body_too_large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function getSettingsView() {
  return {
    upstreamBaseUrl: settings.upstreamBaseUrl,
    hasUpstreamApiKey: Boolean(settings.upstreamApiKey),
    hasRelayApiKey: Boolean(settings.relayApiKey),
    modelAllowlist: [...settings.modelAllowlist],
    allowedOrigins: [...settings.allowedOrigins],
    maxBodyBytes: settings.maxBodyBytes,
    upstreamTimeoutMs: settings.upstreamTimeoutMs,
  };
}
function getOverview() {
  return {
    status: settings.upstreamApiKey && settings.relayApiKey ? 'ready' : 'setup_required',
    adminEnabled: Boolean(ADMIN_PASSWORD),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requestCount: metrics.requests,
    errorCount: metrics.errors,
    recent: metrics.recent.slice(0, 8),
    settings: getSettingsView(),
  };
}
async function persistSettings() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await chmod(SETTINGS_FILE, 0o600).catch(() => {});
}
async function loadSettings() {
  try {
    const saved = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    if (saved && typeof saved === 'object') {
      for (const key of ['upstreamBaseUrl', 'upstreamApiKey', 'relayApiKey', 'modelAllowlist', 'allowedOrigins', 'maxBodyBytes', 'upstreamTimeoutMs']) {
        if (saved[key] !== undefined) settings[key] = saved[key];
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not load saved settings:', error.message);
  }
}
function validateSettings(input) {
  if (typeof input.upstreamBaseUrl !== 'string' || input.upstreamBaseUrl.length > 500) throw new Error('上游 API 地址格式不正确。');
  let parsed;
  try { parsed = new URL(input.upstreamBaseUrl); } catch { throw new Error('请填写有效的上游 API 地址。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('上游地址须为 HTTP(S) URL，且不能包含账号、查询参数或片段。');
  }
  if (!Array.isArray(input.modelAllowlist) || input.modelAllowlist.length > 100 || input.modelAllowlist.some((x) => typeof x !== 'string' || x.length > 120)) throw new Error('模型白名单格式不正确。');
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 50 || input.allowedOrigins.some((x) => typeof x !== 'string' || x.length > 300)) throw new Error('跨域来源格式不正确。');
  const maxBodyBytes = Number(input.maxBodyBytes);
  const upstreamTimeoutMs = Number(input.upstreamTimeoutMs);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 100 * 1024 * 1024) throw new Error('请求体限制须在 1 KiB 到 100 MiB 之间。');
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1000 || upstreamTimeoutMs > 900_000) throw new Error('上游超时须在 1 秒到 15 分钟之间。');
  return {
    upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/+$/, ''),
    modelAllowlist: input.modelAllowlist.map((x) => x.trim()).filter(Boolean),
    allowedOrigins: input.allowedOrigins.map((x) => x.trim()).filter(Boolean),
    maxBodyBytes,
    upstreamTimeoutMs,
  };
}
function corsHeaders(req) {
  const origin = req.headers.origin;
  const origins = settings.allowedOrigins;
  if (!origin || !origins.includes('*') && !origins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origins.includes('*') ? '*' : origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type, Accept, OpenAI-Beta',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
function adminCookie(req, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `relay_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function addRequestMetric(req, res, started) {
  if (!new URL(req.url, 'http://relay.local').pathname.startsWith('/v1/')) return;
  res.once('finish', () => {
    metrics.requests += 1;
    if (res.statusCode >= 400) metrics.errors += 1;
    metrics.recent.unshift({
      time: new Date().toISOString(),
      method: req.method,
      path: new URL(req.url, 'http://relay.local').pathname,
      status: res.statusCode,
      durationMs: Date.now() - started,
    });
    metrics.recent.length = Math.min(metrics.recent.length, 100);
  });
}

const ROUTES = new Map([
  ['/v1/models', new Set(['GET'])],
  ['/v1/chat/completions', new Set(['POST'])],
  ['/v1/responses', new Set(['POST'])],
  ['/v1/embeddings', new Set(['POST'])],
  ['/v1/images/generations', new Set(['POST'])],
  ['/v1/audio/transcriptions', new Set(['POST'])],
  ['/v1/audio/translations', new Set(['POST'])],
]);

async function handleAdminApi(req, res, url) {
  if (url.pathname === '/api/public/status' && req.method === 'GET') {
    return json(res, 200, {
      status: settings.upstreamApiKey && settings.relayApiKey ? 'ready' : 'setup_required',
      adminEnabled: Boolean(ADMIN_PASSWORD),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
  }

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    if (!ADMIN_PASSWORD) return errorJson(res, 503, 'configuration_error', '管理员登录未启用，请在服务端设置 ADMIN_PASSWORD。');
    const ip = req.socket.remoteAddress || 'unknown';
    const attempts = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    if (attempts.resetAt < Date.now()) { attempts.count = 0; attempts.resetAt = Date.now() + 15 * 60 * 1000; }
    if (attempts.count >= 8) return errorJson(res, 429, 'rate_limit_error', '登录尝试过多，请稍后再试。', { 'retry-after': String(Math.max(1, Math.ceil((attempts.resetAt - Date.now()) / 1000))) });
    let body;
    try { body = await readJson(req); } catch { return errorJson(res, 400, 'invalid_request_error', '登录请求格式不正确。'); }
    if (!safeEqual(body.password, ADMIN_PASSWORD)) {
      attempts.count += 1; loginAttempts.set(ip, attempts);
      return errorJson(res, 401, 'authentication_error', '管理员密码不正确。');
    }
    loginAttempts.delete(ip);
    const id = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    sessions.set(id, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
    return json(res, 200, { csrfToken: csrf }, { 'set-cookie': adminCookie(req, id, SESSION_TTL_MS / 1000) });
  }

  if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
    const session = requireAdmin(req, res, true);
    if (!session) return;
    const id = cookies(req).relay_session;
    sessions.delete(id);
    return json(res, 200, { ok: true }, { 'set-cookie': adminCookie(req, '', 0) });
  }

  if (url.pathname === '/api/admin/session' && req.method === 'GET') {
    const session = sessionFor(req);
    if (!session) return errorJson(res, 401, 'authentication_error', '登录状态已过期。');
    return json(res, 200, { csrfToken: session.csrf });
  }

  if (url.pathname.startsWith('/api/admin/')) {
    if (!['GET', 'PUT', 'POST'].includes(req.method)) return errorJson(res, 405, 'method_not_allowed', '此管理接口不支持该请求方法。', { allow: 'GET, PUT, POST' });
    const session = requireAdmin(req, res, req.method !== 'GET');
    if (!session) return;

    if (url.pathname === '/api/admin/overview' && req.method === 'GET') return json(res, 200, getOverview());
    if (url.pathname === '/api/admin/settings' && req.method === 'GET') return json(res, 200, getSettingsView());
    if (url.pathname === '/api/admin/settings' && req.method === 'PUT') {
      let input;
      try { input = await readJson(req); } catch (error) { return errorJson(res, error.status || 400, 'invalid_request_error', '设置内容格式不正确。'); }
      try {
        const validated = validateSettings(input);
        settings.upstreamBaseUrl = validated.upstreamBaseUrl;
        settings.modelAllowlist = validated.modelAllowlist;
        settings.allowedOrigins = validated.allowedOrigins;
        settings.maxBodyBytes = validated.maxBodyBytes;
        settings.upstreamTimeoutMs = validated.upstreamTimeoutMs;
        if (typeof input.upstreamApiKey === 'string' && input.upstreamApiKey.trim()) settings.upstreamApiKey = input.upstreamApiKey.trim();
        if (typeof input.relayApiKey === 'string' && input.relayApiKey.trim()) settings.relayApiKey = input.relayApiKey.trim();
        await persistSettings();
        return json(res, 200, { ok: true, settings: getSettingsView() });
      } catch (error) {
        return errorJson(res, 400, 'invalid_request_error', error.message || '无法保存设置。');
      }
    }
    if (url.pathname === '/api/admin/test-upstream' && req.method === 'POST') {
      if (!settings.upstreamApiKey) return errorJson(res, 400, 'configuration_error', '请先保存上游 API Key。');
      const basePath = new URL(settings.upstreamBaseUrl).pathname.replace(/\/+$/, '');
      const target = `${settings.upstreamBaseUrl}${basePath.endsWith('/v1') ? '/models' : '/v1/models'}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(settings.upstreamTimeoutMs, 15_000));
      try {
        const response = await fetch(target, { headers: { authorization: `Bearer ${settings.upstreamApiKey}` }, signal: controller.signal });
        const text = await response.text();
        let modelCount = null;
        try { modelCount = JSON.parse(text)?.data?.length ?? null; } catch {}
        if (!response.ok) return errorJson(res, 502, 'upstream_error', `上游返回 HTTP ${response.status}。`);
        return json(res, 200, { ok: true, modelCount });
      } catch {
        return errorJson(res, 502, 'upstream_error', '无法连接上游 API，请检查地址、密钥和网络。');
      } finally { clearTimeout(timer); }
    }
    if (url.pathname === '/api/admin/logs' && req.method === 'GET') return json(res, 200, { items: metrics.recent });
    return errorJson(res, 404, 'not_found', '管理接口不存在。');
  }
  return false;
}

async function handleRelay(req, res, url, cors) {
  if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' }, cors);
  if (!settings.relayApiKey) return errorJson(res, 503, 'configuration_error', '中转尚未配置：请设置 RELAY_API_KEY。', cors);
  if (!settings.upstreamApiKey) return errorJson(res, 503, 'configuration_error', '中转尚未配置：请设置 UPSTREAM_API_KEY。', cors);
  const supplied = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!safeEqual(supplied, settings.relayApiKey)) return errorJson(res, 401, 'authentication_error', '中转 API Key 缺失或无效。', { ...cors, 'www-authenticate': 'Bearer' });

  const methods = ROUTES.get(url.pathname);
  if (!methods) return errorJson(res, 404, 'not_found', '中转服务不支持此接口。', cors);
  if (!methods.has(req.method)) return errorJson(res, 405, 'method_not_allowed', '此接口不支持该请求方法。', { ...cors, allow: [...methods].join(', ') });

  let body = Buffer.alloc(0);
  try { if (req.method !== 'GET') body = await readRawBody(req); }
  catch (error) { return errorJson(res, error.status || 400, 'invalid_request_error', error.status === 413 ? '请求体超过设置的大小上限。' : '无法读取请求体。', cors); }

  if (settings.modelAllowlist.length && url.pathname !== '/v1/models' && body.length) {
    let model;
    try { model = JSON.parse(body.toString('utf8'))?.model; } catch {}
    if (model && !settings.modelAllowlist.includes(model)) return errorJson(res, 403, 'model_not_allowed', `模型 ${model} 未在白名单中启用。`, cors);
  }

  const basePath = new URL(settings.upstreamBaseUrl).pathname.replace(/\/+$/, '');
  const routePath = basePath.endsWith('/v1') ? url.pathname.slice(3) : url.pathname;
  const target = `${settings.upstreamBaseUrl}${routePath}${url.search}`;
  const headers = new Headers({ authorization: `Bearer ${settings.upstreamApiKey}` });
  for (const name of ['content-type', 'accept', 'openai-beta']) if (req.headers[name]) headers.set(name, req.headers[name]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Upstream timeout')), settings.upstreamTimeoutMs);
  res.on('close', () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); });

  try {
    const upstream = await fetch(target, { method: req.method, headers, body: req.method === 'GET' ? undefined : body, signal: controller.signal, redirect: 'manual' });
    const responseHeaders = { ...cors };
    for (const name of ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms', 'retry-after']) {
      const value = upstream.headers.get(name); if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) { clearTimeout(timer); return res.end(); }
    res.once('close', () => clearTimeout(timer));
    res.once('finish', () => clearTimeout(timer));
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    clearTimeout(timer);
    if (res.headersSent || res.destroyed) return;
    const timedOut = controller.signal.aborted && controller.signal.reason?.message === 'Upstream timeout';
    return errorJson(res, timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_error', timedOut ? '上游请求超时。' : '无法连接上游 API。', cors);
  }
}

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== path.join(PUBLIC_DIR, 'index.html')) return errorJson(res, 404, 'not_found', '页面不存在。');
  try {
    const content = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(target)] || 'application/octet-stream',
      'cache-control': target.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    });
    res.end(content);
  } catch { errorJson(res, 404, 'not_found', '页面不存在。'); }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://relay.local');
  const started = Date.now();
  addRequestMetric(req, res, started);
  if (url.pathname.startsWith('/api/')) {
    const result = await handleAdminApi(req, res, url);
    if (result !== false) return result;
  }
  if (url.pathname === '/' || url.pathname.startsWith('/assets/')) return serveStatic(req, res, url.pathname);
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  return handleRelay(req, res, url, cors);
}

await loadSettings();
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error('Unhandled relay error:', error);
    if (!res.headersSent) errorJson(res, 500, 'internal_error', '中转服务内部错误。');
    else res.destroy();
  });
});
server.listen(PORT, HOST, () => console.log(`Relay management console listening on http://${HOST}:${PORT}`));
function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
