import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let upstream;
let relayPort;
let upstreamPort;
let relayProcess;
let captured;
let dataDir;

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  captured = {};
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'relay-test-'));
  upstreamPort = await freePort();
  relayPort = await freePort();
  upstream = http.createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    captured = { url: req.url, method: req.method, authorization: req.headers.authorization, body: Buffer.concat(buffers).toString() };
    if (JSON.parse(captured.body || '{}').stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'stream-id' });
      res.write('data: first\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'test-id' });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(upstreamPort, '127.0.0.1');
  await once(upstream, 'listening');

  relayProcess = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(relayPort),
      HOST: '127.0.0.1',
      UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      UPSTREAM_API_KEY: 'upstream-secret',
      RELAY_API_KEY: 'relay-secret',
      MODEL_ALLOWLIST: 'allowed-model',
      ADMIN_PASSWORD: 'admin-secret',
      DATA_DIR: dataDir,
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Relay did not start in time');
});

after(async () => {
  relayProcess?.kill('SIGTERM');
  if (relayProcess) await once(relayProcess, 'exit');
  await new Promise((resolve) => upstream?.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('health check is available without a relay key', async () => {
  const response = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('rejects calls without a valid relay key', async () => {
  const response = await fetch(`http://127.0.0.1:${relayPort}/v1/models`);
  assert.equal(response.status, 401);
});

test('forwards authorized requests with the upstream key and preserves query strings', async () => {
  const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions?foo=bar`, {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'allowed-model', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-request-id'), 'test-id');
  assert.equal(captured.url, '/v1/chat/completions?foo=bar');
  assert.equal(captured.authorization, 'Bearer upstream-secret');
  assert.equal(JSON.parse(captured.body).model, 'allowed-model');
});

test('passes server-sent event responses through', async () => {
  const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'allowed-model', stream: true, messages: [] }),
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('x-request-id'), 'stream-id');
  assert.equal(await response.text(), 'data: first\n\ndata: [DONE]\n\n');
});

test('blocks models outside the configured allowlist', async () => {
  const response = await fetch(`http://127.0.0.1:${relayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer relay-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'blocked-model', messages: [] }),
  });
  assert.equal(response.status, 403);
});

test('serves the Chinese management homepage and public health summary', async () => {
  const home = await fetch(`http://127.0.0.1:${relayPort}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /RelayDesk/);
  const status = await fetch(`http://127.0.0.1:${relayPort}/api/public/status`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).adminEnabled, true);
});

test('admin can log in, update settings, and read masked credential status', async () => {
  const login = await fetch(`http://127.0.0.1:${relayPort}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin-secret' }),
  });
  assert.equal(login.status, 200);
  const { csrfToken } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const saved = await fetch(`http://127.0.0.1:${relayPort}/api/admin/settings`, {
    method: 'PUT',
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`, upstreamApiKey: 'changed-upstream', relayApiKey: 'changed-relay',
      modelAllowlist: ['allowed-model'], allowedOrigins: [], maxBodyBytes: 10485760, upstreamTimeoutMs: 300000,
    }),
  });
  assert.equal(saved.status, 200);
  const view = await saved.json();
  assert.equal(view.settings.hasUpstreamApiKey, true);
  assert.equal(view.settings.hasRelayApiKey, true);
  assert.equal(JSON.stringify(view).includes('changed-upstream'), false);
  const overview = await fetch(`http://127.0.0.1:${relayPort}/api/admin/overview`, { headers: { cookie } });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).status, 'ready');
});
