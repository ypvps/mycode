const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const csrf = { token: '' };
let appStatus = { adminEnabled: false, status: 'setup_required' };
let toastTimer;
const titles = { overview: '总览', api: '接口与模型', requests: '请求记录', settings: '系统设置' };

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && options.method !== 'GET' && csrf.token) headers.set('x-csrf-token', csrf.token);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function notify(message, kind = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}
function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天 ${hours}小时`;
  if (hours) return `${hours}小时 ${minutes}分`;
  if (minutes) return `${minutes}分钟`;
  return `${seconds}秒`;
}
function setHealth(ready) {
  const text = ready ? '运行正常' : '待完成配置';
  $('#stat-health').textContent = ready ? '在线' : '待配置';
  $('#health-pill').className = `status-pill ${ready ? 'ready' : 'pending'}`;
  $('#health-pill').innerHTML = `<i></i>${text}`;
  $('#side-status').textContent = ready ? '在线' : '待配置';
  $('#top-status').textContent = ready ? '运行正常' : '配置待完成';
  $('.top-live').classList.toggle('warning', !ready);
  $('#setup-notice').classList.toggle('hidden', ready);
  if (ready) {
    $('#notice-title').textContent = '中转服务已就绪';
    $('#notice-text').textContent = '服务配置完整。将 Base URL 和中转密钥填入你的 OpenAI 兼容 App 即可使用。';
  } else if (!appStatus.adminEnabled) {
    $('#notice-title').textContent = '请先设置管理员密码';
    $('#notice-text').textContent = '管理界面尚未启用。请在服务端配置 ADMIN_PASSWORD 并重启服务。';
    $('#login-open').disabled = true;
    $('#login-open').title = '请先在服务端设置 ADMIN_PASSWORD';
  } else {
    $('#notice-title').textContent = '完成初始化，开始使用中转服务';
    $('#notice-text').textContent = '登录管理控制台，配置上游 API 凭证与中转访问密钥。';
  }
}
function setLoggedIn(value) {
  $('#logout-button').classList.toggle('hidden', !value);
  $('#login-open').classList.toggle('hidden', value);
  $('#user-state').textContent = value ? '管理员' : '访客模式';
  $('#user-subtitle').textContent = value ? '安全会话已启用' : '管理员登录';
  $$('.nav-item').forEach((button) => {
    button.disabled = !value && button.dataset.page !== 'overview';
    button.classList.toggle('nav-disabled', button.disabled);
  });
}
function navigate(page) {
  if (!titles[page]) return;
  if (!csrf.token && page !== 'overview') { openLogin(); return; }
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#crumb-title').textContent = titles[page];
  if (page === 'api' || page === 'settings') loadSettings();
  if (page === 'requests') loadLogs();
  if (page === 'overview' && csrf.token) loadOverview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function openLogin() {
  if (!appStatus.adminEnabled) {
    notify('管理员登录未启用，请配置 ADMIN_PASSWORD。', 'error');
    return;
  }
  $('#login-modal').classList.add('open');
  $('#login-modal').setAttribute('aria-hidden', 'false');
  setTimeout(() => $('#admin-password').focus(), 80);
}
function closeLogin() {
  $('#login-modal').classList.remove('open');
  $('#login-modal').setAttribute('aria-hidden', 'true');
}
function renderActivity(items = []) {
  const container = $('#recent-requests');
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<span class="empty-icon">⌁</span><strong>暂无请求记录</strong><span>API 被调用后，活动会显示在这里。</span>';
    container.append(empty);
    return;
  }
  for (const item of items.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const ok = item.status < 400;
    const badge = document.createElement('span');
    badge.className = `activity-status ${ok ? 'ok' : 'bad'}`;
    badge.textContent = String(item.status);
    const details = document.createElement('div');
    details.className = 'activity-detail';
    const path = document.createElement('strong'); path.textContent = item.path;
    const method = document.createElement('span'); method.textContent = `${item.method} · ${new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    details.append(path, method);
    const duration = document.createElement('span'); duration.className = 'activity-duration'; duration.textContent = `${item.durationMs} ms`;
    row.append(badge, details, duration);
    container.append(row);
  }
}
async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');
    setHealth(data.status === 'ready');
    $('#stat-requests').textContent = Number(data.requestCount).toLocaleString();
    $('#stat-errors').textContent = Number(data.errorCount).toLocaleString();
    $('#stat-uptime').textContent = formatUptime(data.uptimeSeconds);
    $('#uptime-inline').textContent = `运行 ${formatUptime(data.uptimeSeconds)}`;
    renderActivity(data.recent);
    renderModels(data.settings.modelAllowlist);
    $('#key-hint').textContent = data.settings.hasRelayApiKey ? '中转密钥已配置' : '尚未设置中转密钥';
  } catch (error) { if (error.status === 401) expireSession(); }
}
function renderModels(models = []) {
  const summary = $('#model-summary');
  summary.replaceChildren();
  const orb = document.createElement('span'); orb.className = 'model-orb'; orb.textContent = '✳';
  const text = document.createElement('div');
  if (!models.length) {
    const title = document.createElement('strong'); title.textContent = '模型白名单未设置';
    const detail = document.createElement('span'); detail.textContent = '当前可透传上游账号允许的模型。';
    text.append(title, detail);
  } else {
    const title = document.createElement('strong'); title.textContent = `${models.length} 个模型已启用`;
    const chips = document.createElement('div'); chips.className = 'model-chips';
    for (const model of models.slice(0, 5)) { const chip = document.createElement('span'); chip.textContent = model; chips.append(chip); }
    if (models.length > 5) { const more = document.createElement('span'); more.textContent = `+${models.length - 5}`; chips.append(more); }
    text.append(title, chips);
  }
  summary.append(orb, text);
}
async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    $('#upstream-url').value = data.upstreamBaseUrl;
    $('#model-list').value = data.modelAllowlist.join(', ');
    $('#allowed-origins').value = data.allowedOrigins.join(', ');
    $('#body-limit').value = Math.round(data.maxBodyBytes / 1024 / 1024);
    $('#timeout-seconds').value = Math.round(data.upstreamTimeoutMs / 1000);
    $('#upstream-key-state').textContent = data.hasUpstreamApiKey ? '已配置 · 不可见' : '尚未配置';
    $('#relay-key-state').textContent = data.hasRelayApiKey ? '已配置 · 不可见' : '尚未配置';
    $('#admin-password-state').textContent = appStatus.adminEnabled ? '已启用' : '未启用';
    $('#admin-password-state').className = appStatus.adminEnabled ? 'good-text' : 'bad-text';
    $('#upstream-config-state').textContent = data.hasUpstreamApiKey ? '已配置' : '未配置';
    $('#upstream-config-state').className = data.hasUpstreamApiKey ? 'good-text' : 'bad-text';
    $('#relay-config-state').textContent = data.hasRelayApiKey ? '已配置' : '未配置';
    $('#relay-config-state').className = data.hasRelayApiKey ? 'good-text' : 'bad-text';
  } catch (error) { if (error.status === 401) expireSession(); else notify(error.message, 'error'); }
}
function renderLogs(items = []) {
  const body = $('#logs-body');
  body.replaceChildren();
  $('#log-count').textContent = `${items.length} 条记录`;
  if (!items.length) {
    const row = document.createElement('tr'); const cell = document.createElement('td');
    cell.colSpan = 5; cell.className = 'table-empty'; cell.textContent = '暂无 API 请求。发起调用后记录会显示在这里。'; row.append(cell); body.append(row); return;
  }
  for (const item of items) {
    const row = document.createElement('tr');
    const statusCell = document.createElement('td'); const status = document.createElement('span');
    status.className = `table-status ${item.status < 400 ? 'ok' : 'bad'}`; status.innerHTML = `<i></i>${item.status < 400 ? '成功' : '异常'} <b>${item.status}</b>`; statusCell.append(status);
    const path = document.createElement('td'); path.className = 'table-path'; path.textContent = item.path;
    const method = document.createElement('td'); const methodTag = document.createElement('span'); methodTag.className = 'method-tag'; methodTag.textContent = item.method; method.append(methodTag);
    const duration = document.createElement('td'); duration.textContent = `${item.durationMs} ms`;
    const time = document.createElement('td'); time.textContent = new Date(item.time).toLocaleString();
    row.append(statusCell, path, method, duration, time); body.append(row);
  }
}
async function loadLogs() {
  try { const data = await api('/api/admin/logs'); renderLogs(data.items); }
  catch (error) { if (error.status === 401) expireSession(); else notify(error.message, 'error'); }
}
function expireSession() {
  csrf.token = ''; setLoggedIn(false); renderActivity([]); notify('登录状态已过期，请重新登录。', 'error');
}
function splitList(value) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
async function saveSettings(section) {
  const body = {
    upstreamBaseUrl: $('#upstream-url').value.trim(),
    upstreamApiKey: $('#upstream-key').value.trim(),
    relayApiKey: $('#relay-key').value.trim(),
    modelAllowlist: splitList($('#model-list').value),
    allowedOrigins: splitList($('#allowed-origins').value),
    maxBodyBytes: Math.round(Number($('#body-limit').value) * 1024 * 1024),
    upstreamTimeoutMs: Math.round(Number($('#timeout-seconds').value) * 1000),
  };
  if (!body.maxBodyBytes) body.maxBodyBytes = 10 * 1024 * 1024;
  if (!body.upstreamTimeoutMs) body.upstreamTimeoutMs = 300000;
  const button = section === 'api' ? $('#save-settings') : $('#save-system');
  const original = button.textContent; button.disabled = true; button.textContent = '保存中…';
  try {
    const result = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
    $('#upstream-key').value = ''; $('#relay-key').value = '';
    $('#upstream-key-state').textContent = result.settings.hasUpstreamApiKey ? '已配置 · 不可见' : '尚未配置';
    $('#relay-key-state').textContent = result.settings.hasRelayApiKey ? '已配置 · 不可见' : '尚未配置';
    $('#settings-save-hint, #system-save-hint').textContent = '已安全保存至服务器';
    $('#settings-save-hint, #system-save-hint').classList.add('saved');
    notify('配置已保存');
    setHealth(result.settings.hasUpstreamApiKey && result.settings.hasRelayApiKey);
    renderModels(result.settings.modelAllowlist);
    $('#key-hint').textContent = result.settings.hasRelayApiKey ? '中转密钥已配置' : '尚未设置中转密钥';
    await loadSettings();
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = original; }
}
async function testUpstream() {
  const button = $('#test-upstream');
  button.disabled = true; button.querySelector('span').textContent = '正在测试…';
  try {
    const result = await api('/api/admin/test-upstream', { method: 'POST', body: '{}' });
    notify(result.modelCount == null ? '上游连接成功' : `连接成功 · 上游返回 ${result.modelCount} 个模型`);
  } catch (error) { notify(error.message, 'error'); }
  finally { button.disabled = false; button.querySelector('span').textContent = '测试上游连接'; }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); notify('已复制到剪贴板'); }
  catch { notify('复制失败，请手动复制', 'error'); }
}
async function init() {
  $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const base = `${location.origin}/v1`;
  $('#base-url').textContent = base;
  $('#curl-url').textContent = `${location.origin}/v1/models`;
  $('#curl-command').textContent = `curl ${location.origin}/v1/models -H 'Authorization: Bearer 你的中转密钥'`;
  try {
    appStatus = await (await fetch('/api/public/status', { cache: 'no-store' })).json();
    setHealth(appStatus.status === 'ready');
    $('#stat-uptime').textContent = formatUptime(appStatus.uptimeSeconds);
    $('#uptime-inline').textContent = `运行 ${formatUptime(appStatus.uptimeSeconds)}`;
    if (appStatus.adminEnabled) {
      try {
        const session = await api('/api/admin/session');
        csrf.token = session.csrfToken; setLoggedIn(true); await loadOverview();
      } catch { setLoggedIn(false); }
    } else setLoggedIn(false);
  } catch {
    $('#top-status').textContent = '无法连接'; $('#stat-health').textContent = '离线'; $('#side-status').textContent = '离线';
    $('#notice-title').textContent = '无法连接到 Relay 服务'; $('#notice-text').textContent = '请检查服务进程是否运行，或刷新页面重试。';
  }
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
$('#login-open').addEventListener('click', openLogin);
$('#login-close').addEventListener('click', closeLogin);
$('#login-modal').addEventListener('click', (event) => { if (event.target === $('#login-modal')) closeLogin(); });
$('#refresh-button').addEventListener('click', async () => {
  if (csrf.token) { await loadOverview(); notify('状态已刷新'); }
  else { try { const status = await (await fetch('/api/public/status', { cache: 'no-store' })).json(); appStatus = status; setHealth(status.status === 'ready'); notify('状态已刷新'); } catch { notify('刷新失败', 'error'); } }
});
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  const button = $('.login-submit'); button.disabled = true; button.innerHTML = '验证中…';
  try {
    const result = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#admin-password').value }) });
    csrf.token = result.csrfToken; $('#admin-password').value = ''; closeLogin(); setLoggedIn(true); await loadOverview(); await loadSettings(); notify('登录成功，欢迎回来');
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; button.innerHTML = '安全登录 <span>→</span>'; }
});
$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
  csrf.token = ''; setLoggedIn(false); navigate('overview'); notify('已安全退出');
});
$('#save-settings').addEventListener('click', () => saveSettings('api'));
$('#save-system').addEventListener('click', () => saveSettings('settings'));
$('#test-upstream').addEventListener('click', testUpstream);
$('#refresh-logs').addEventListener('click', loadLogs);
$$('[data-toggle]').forEach((button) => button.addEventListener('click', () => {
  const input = $(`#${button.dataset.toggle}`); input.type = input.type === 'password' ? 'text' : 'password'; button.textContent = input.type === 'password' ? '显示' : '隐藏';
}));
$$('[data-copy]').forEach((button) => button.addEventListener('click', () => {
  const target = $(`#${button.dataset.copy}`); copyText(target.textContent.trim());
}));
$('#refresh-button').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadOverview(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeLogin(); });
init();
