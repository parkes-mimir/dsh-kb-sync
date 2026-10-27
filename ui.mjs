// ui.mjs —— 插件内置的本地可视化面板（不依赖 dsh 客户端插件）
// 只监听 127.0.0.1，提供：服务器地址/设备名/同步间隔配置、每个空间 local|cloud 切换、开关、立即同步。
import http from 'node:http';

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-kb-sync · 知识库同步</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Noto Sans SC", sans-serif; margin: 0; padding: 24px; background: #0f1115; color: #e6e8eb; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a1; font-size: 12px; margin-bottom: 20px; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8b93a1; }
  input, select { background: #0f1115; color: #e6e8eb; border: 1px solid #2a3040; border-radius: 6px; padding: 7px 9px; font: inherit; min-width: 220px; }
  button { background: #2f6feb; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button.ghost { background: transparent; border: 1px solid #2a3040; color: #c9cfd8; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #22262f; font-size: 13px; }
  th { color: #8b93a1; font-weight: 500; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .cloud { background: #14324f; color: #7cc4ff; }
  .local { background: #3a2a12; color: #ffc46b; }
  .muted { color: #6b7280; }
  #msg { position: fixed; right: 16px; bottom: 16px; background: #1f2937; border: 1px solid #374151; padding: 8px 12px; border-radius: 8px; opacity: 0; transition: opacity .2s; }
  #msg.show { opacity: 1; }
</style></head><body>
<h1>知识库同步</h1>
<div class="sub">本地面板 · 只有 127.0.0.1 能访问 · 改动立即写入 ~/.mnemon/state/kb-sync.json</div>

<div class="card">
  <div class="row">
    <label>服务器地址<input id="remote" placeholder="ssh://mnemon@host/path/mnemon-sync.git"></label>
    <label>本机设备名<input id="device" placeholder="nixos"></label>
    <label>兜底同步（分钟）<input id="interval" type="number" min="5" style="min-width:110px"></label>
    <button onclick="saveConfig()">保存并首次同步</button>
    <button class="ghost" onclick="syncNow()">立即同步</button>
  </div>
  <div class="sub" id="syncinfo" style="margin:12px 0 0"></div>
</div>

<div class="card">
  <table><thead><tr><th>记忆空间</th><th>模式</th><th>同步</th><th>本机</th><th>云端</th><th>缺失</th></tr></thead>
  <tbody id="spaces"></tbody></table>
</div>

<div id="msg"></div>
<script>
let state = null;
const msg = (t) => { const m = document.getElementById('msg'); m.textContent = t; m.classList.add('show'); setTimeout(() => m.classList.remove('show'), 1800); };
async function load() {
  const r = await fetch('/api/state'); state = await r.json();
  document.getElementById('remote').value = state.remote || '';
  document.getElementById('device').value = state.device || '';
  document.getElementById('interval').value = state.intervalMinutes || 30;
  document.getElementById('syncinfo').textContent = '上次同步：' + (state.lastSync || '从未') + '　仓库：' + (state.repoDir || '-');
  const tbody = document.getElementById('spaces');
  tbody.innerHTML = '';
  for (const s of state.spaces) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + s.space + '</td>' +
      '<td><span class="pill ' + s.mode + '">' + s.mode + '</span></td>' +
      '<td><input type="checkbox" ' + (s.enabled ? 'checked' : '') + ' onchange="setSpace(\'' + s.space + '\', {enabled: this.checked})"></td>' +
      '<td>' + s.local + '</td><td>' + s.remote + '</td><td class="muted">' + s.missingLocal + '</td>';
    const sel = document.createElement('select');
    sel.style.minWidth = '110px';
    sel.innerHTML = '<option value="cloud">cloud</option><option value="local">local</option>';
    sel.value = s.mode;
    sel.onchange = () => setSpace(s.space, { mode: sel.value });
    tr.children[1].innerHTML = '';
    tr.children[1].appendChild(sel);
    tbody.appendChild(tr);
  }
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok === false) msg('失败：' + (j.detail || '未知错误')); else msg('已保存');
  await load();
  return j;
}
async function saveConfig() {
  const body = {
    remote: document.getElementById('remote').value.trim(),
    device: document.getElementById('device').value.trim(),
    intervalMinutes: Number(document.getElementById('interval').value) || 30,
  };
  const j = await post('/api/config', body);
  if (j.firstSync) msg('已保存，首次同步：导入 ' + (j.firstSync.imported ?? 0) + ' 条');
}
async function setSpace(space, patch) { await post('/api/space', { space, ...patch }); }
async function syncNow() { const j = await post('/api/sync', {}); msg('同步完成：导入 ' + (j.imported ?? 0) + ' / 导出 ' + (j.exported ?? 0) + (j.pushed ? ' / 已推送' : '')); }
load();
setInterval(load, 5000);
</script></body></html>`;

export function startUi(api) {
  const { cfg, readState, writeState, spacePolicy, listLocalSpaces, readLocalInsights, repoMarks, syncAll, log } = api;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, HTML, 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = readState(cfg);
        const marks = repoMarks(state.repoDir);
        const local = listLocalSpaces(cfg);
        const spaces = [];
        for (const space of new Set([...Object.keys(local), ...Object.keys(marks)])) {
          const policy = spacePolicy(state, space);
          const rows = local[space] ? readLocalInsights(local[space]) ?? [] : [];
          const have = new Set(rows.filter((r) => !r.deleted_at).map((r) => r.h));
          const want = new Set(Object.entries(marks[space] ?? {}).filter(([, r]) => !r.deleted).map(([h]) => h));
          spaces.push({ space, mode: policy.mode, enabled: policy.enabled, local: have.size, remote: want.size, missingLocal: [...want].filter((h) => !have.has(h)).length });
        }
        return send(200, JSON.stringify({ remote: state.remote, device: state.device, repoDir: state.repoDir, intervalMinutes: state.intervalMinutes, lastSync: state.lastSync, spaces }));
      }
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        const state = readState(cfg);
        if (url.pathname === '/api/config') {
          if (typeof body.remote === 'string') state.remote = body.remote.trim();
          if (typeof body.device === 'string' && body.device.trim()) state.device = body.device.trim();
          if (Number.isFinite(Number(body.intervalMinutes))) state.intervalMinutes = Math.max(5, Number(body.intervalMinutes));
          writeState(cfg, state);
          const firstSync = await syncAll(cfg, readState(cfg), log);
          const ok = firstSync.ok !== false || !readState(cfg).remote;
          return send(200, JSON.stringify({ ok, saved: true, firstSync, detail: firstSync.ok === false ? (firstSync.detail ?? '') : '' }));
        }
        if (url.pathname === '/api/space') {
          const space = String(body.space || '').trim();
          if (!space) return send(200, JSON.stringify({ ok: false, detail: '缺少 space' }));
          const entry = state.spaces[space] ?? {};
          if (body.mode === 'local' || body.mode === 'cloud') entry.mode = body.mode;
          if (typeof body.enabled === 'boolean') entry.enabled = body.enabled;
          state.spaces[space] = entry;
          writeState(cfg, state);
          return send(200, JSON.stringify({ ok: true, space, ...spacePolicy(readState(cfg), space) }));
        }
        if (url.pathname === '/api/sync') {
          const result = await syncAll(cfg, readState(cfg), log);
          return send(200, JSON.stringify(result));
        }
      }
      return send(404, JSON.stringify({ ok: false, detail: 'not found' }));
    } catch (error) {
      log?.('warn', 'ui: ' + (error?.message ?? error));
      return send(500, JSON.stringify({ ok: false, detail: String(error?.message ?? error) }));
    }
  });
  server.listen(Number(cfg.uiPort) || 7393, cfg.uiHost || '127.0.0.1', () => {
    log?.('info', 'ui on http://' + (cfg.uiHost || '127.0.0.1') + ':' + (Number(cfg.uiPort) || 7393) + '/');
  });
  server.unref?.();
  return server;
}
