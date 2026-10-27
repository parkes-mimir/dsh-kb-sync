// dsh-kb-sync v0.2 —— 共享知识库（mnemon 记忆空间）跨设备同步插件
//
// 只依赖：dsh-mnemon 注册的记忆空间（本地 SQLite）+ Mnemon Native 的 mnemon CLI + git。
// 不 import @deepseek-ai/dsh-tools，也不依赖系统 systemd：插件自己管同步。
//
// 语义（与用户约定）：
//   · 配好 remote（ssh:// 或 https://，局域网/公网都行）后自动克隆并拉取最新记忆空间。
//   · 记忆空间分两种模式：cloud（默认，双向同步）/ local（只留在本机，绝不上传）。
//   · 每个空间可单独 enable/disable；禁用的空间不拉不推，重新开启后从仓库补齐。
//   · 写入落库后 ~30s 内自动推送（mtime 侦测 + 去抖），并定期全量同步一次。
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);

import z from '@deepseek-ai/schemastery';

export const name = 'kb-sync';

// 这张 schema 就是「设置 → 插件 → dsh-kb-sync」里的那张表单：
// 带 .volatile() 的字段可编辑，保存后写回 profile 里该条目的 config。
export const Config = z.object({
  remote: z.string().default('').description('共享知识库地址（ssh:// 或 https://）；留空 = 只在本机，不同步').volatile(),
  device: z.string().default('').description('本机在仓库里的分片名；留空 = 用主机名').volatile(),
  intervalMinutes: z.number().default(30).description('兜底对账间隔（分钟）；0 = 关闭，只靠事件触发').volatile(),
  notifyUrl: z.string().default('').description('hub 通知服务地址（http://host:7392）；留空 = 不实时通知，只靠兜底').volatile(),
  notifyToken: z.string().default('').description('hub 通知服务 token').volatile(),
  spaces: z.dict(z.object({
    mode: z.string().default('cloud').description('cloud = 双向同步；local = 只留本机'),
    enabled: z.boolean().default(true).description('false = 暂停该空间的同步'),
  })).default({}).description('每个记忆空间的策略；没列出的空间默认 cloud + 启用').volatile(),
});
export const inject = ['tools'];

const DEFAULTS = {
  dataDir: process.env.MNEMON_DATA_DIR || join(homedir(), '.mnemon'),
  remote: '',
  branch: 'main',
  device: hostname(),
  intervalMinutes: 20,
  watchSeconds: 30,
  debounceSeconds: 5,
  mnemonBin: process.env.KB_MNEMON_BIN || '',
  promptOrder: 151,
  notifyUrl: '',
  notifyToken: '',
  gitTimeoutMs: 180000,
};

const sh = (bin, args, opts = {}) => new Promise((resolve) => {
  execFile(bin, args, { timeout: opts.timeoutMs ?? 60000, maxBuffer: 16 * 1024 * 1024, env: opts.env ?? process.env }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

function httpJson(url, timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(new Error('bad json: ' + body.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
const nowIso = () => new Date().toISOString();
const safeJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

function findMnemon(cfg) {
  const candidates = [cfg.mnemonBin, join(homedir(), '.local', 'bin', 'mnemon'), '/usr/local/bin/mnemon', '/usr/bin/mnemon'].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'mnemon';
}

/* ------------------------------------------------------------------ state */

function statePath(cfg) { return join(cfg.dataDir, 'state', 'kb-sync.json'); }

function readState(cfg) {
  const file = statePath(cfg);
  const raw = (existsSync(file) ? safeJson(readFileSync(file, 'utf8')) : undefined) ?? {};
  return {
    version: 1,
    remote: typeof raw.remote === 'string' && raw.remote ? raw.remote : (cfg.remote ?? ''),
    branch: typeof raw.branch === 'string' ? raw.branch : cfg.branch,
    device: typeof raw.device === 'string' ? raw.device : cfg.device,
    repoDir: typeof raw.repoDir === 'string' ? raw.repoDir : join(cfg.dataDir, 'state', 'kb-repo'),
    intervalMinutes: Number.isFinite(raw.intervalMinutes) ? raw.intervalMinutes : (Number(cfg.intervalMinutes) || 30),
    spaces: raw.spaces && Object.keys(raw.spaces).length > 0 ? raw.spaces : (cfg.spaces && typeof cfg.spaces === 'object' ? cfg.spaces : {}),
    notify: raw.notify && typeof raw.notify === 'object'
      ? { url: String(raw.notify.url ?? cfg.notifyUrl ?? ''), token: String(raw.notify.token ?? cfg.notifyToken ?? '') }
      : { url: cfg.notifyUrl ?? '', token: cfg.notifyToken ?? '' },
    lastSync: raw.lastSync,
  };
}

function writeState(cfg, state) {
  mkdirSync(join(cfg.dataDir, 'state'), { recursive: true, mode: 0o700 });
  const file = statePath(cfg);
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

const spacePolicy = (state, space) => {
  const entry = state.spaces[space] ?? {};
  return { mode: entry.mode === 'local' ? 'local' : 'cloud', enabled: entry.enabled !== false };
};

/* ------------------------------------------------------- local mnemon data */

function listLocalSpaces(cfg) {
  const root = join(cfg.dataDir, 'data');
  const out = {};
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const db = join(root, entry.name, 'mnemon.db');
    if (existsSync(db)) out[entry.name] = db;
  }
  return out;
}

function readLocalInsights(dbPath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return undefined; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('select id, content, category, importance, tags, entities, source, created_at, deleted_at from insights').all().map((row) => ({
      id: row.id,
      h: hashOf(row.content),
      content: row.content,
      category: row.category || 'context',
      importance: Number(row.importance ?? 3),
      tags: safeJson(row.tags || '[]') ?? [],
      entities: safeJson(row.entities || '[]') ?? [],
      source: row.source || 'agent',
      created_at: row.created_at,
      deleted_at: row.deleted_at,
    }));
  } finally { db.close(); }
}

function registerLocalSpace(cfg, space, meta) {
  const regPath = join(cfg.dataDir, 'data', '.dsh-memory-bodies.json');
  const reg = safeJson(existsSync(regPath) ? readFileSync(regPath, 'utf8') : '') || { version: 1, bodies: [] };
  reg.bodies = Array.isArray(reg.bodies) ? reg.bodies : [];
  const name = meta?.name || space;
  const description = meta?.description || '由 kb-sync 同步创建';
  const existing = reg.bodies.find((body) => body.id === space);
  if (existing) {
    if (meta && (existing.name !== name || existing.description !== description)) {
      existing.name = name; existing.description = description; existing.updatedAt = nowIso();
      writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
    }
    return false;
  }
  reg.bodies.push({ id: space, name, description, active: true, createdAt: nowIso(), updatedAt: nowIso() });
  writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
  return true;
}

/* ------------------------------------------------------------------- repo */

function repoMarks(repoDir) {
  const marks = {};
  const base = join(repoDir, 'spaces');
  if (!existsSync(base)) return marks;
  for (const space of readdirSync(base, { withFileTypes: true })) {
    if (!space.isDirectory()) continue;
    const per = marks[space.name] = {};
    const dir = join(base, space.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = safeJson(line);
        if (!rec?.h) continue;
        if (rec.deleted) per[rec.h] = rec;
        else if (!per[rec.h]) per[rec.h] = rec;
      }
    }
  }
  return marks;
}

function repoSpaceMeta(repoDir, space) {
  return safeJson(readFileSync(join(repoDir, 'spaces', space, 'space.json'), 'utf8'));
}

/* ------------------------------------------------------------- git helpers */

async function git(cfg, state, args, opts = {}) {
  return sh('git', ['-C', state.repoDir, ...args], { timeoutMs: cfg.gitTimeoutMs, ...opts });
}

async function ensureRepo(cfg, state, log) {
  if (!state.remote) return { ok: false, reason: 'remote 未配置' };
  if (existsSync(join(state.repoDir, '.git'))) {
    const current = await git(cfg, state, ['remote', 'get-url', 'origin']);
    if (!current.ok || current.stdout.trim() !== state.remote) {
      await git(cfg, state, ['remote', 'set-url', 'origin', state.remote]);
      if (!current.ok) await git(cfg, state, ['remote', 'add', 'origin', state.remote]);
    }
    return { ok: true };
  }
  mkdirSync(join(cfg.dataDir, 'state'), { recursive: true, mode: 0o700 });
  const clone = await sh('git', ['clone', state.remote, state.repoDir], { timeoutMs: cfg.gitTimeoutMs });
  if (clone.ok) return { ok: true, cloned: true };
  // 空仓库/网络失败：建本地仓库并挂 remote，下次再拉
  log?.('warn', 'clone failed: ' + clone.stderr.slice(0, 200));
  mkdirSync(state.repoDir, { recursive: true, mode: 0o700 });
  await git(cfg, state, ['init'], {});
  await git(cfg, state, ['remote', 'add', 'origin', state.remote]);
  return { ok: false, reason: clone.stderr.slice(0, 300) };
}

/* ------------------------------------------------------------------ apply */

async function applySpace(cfg, state, space, marks, log) {
  const meta = repoSpaceMeta(state.repoDir, space) ?? {};
  const localSpaces = listLocalSpaces(cfg);
  if (!localSpaces[space]) {
    await sh(findMnemon(cfg), ['--data-dir', cfg.dataDir, 'store', 'create', space], {});
    registerLocalSpace(cfg, space, meta);
  } else {
    registerLocalSpace(cfg, space, meta);
  }
  const db = listLocalSpaces(cfg)[space];
  if (!db) return { space, imported: 0, forgotten: 0 };
  const rows = readLocalInsights(db) ?? [];
  const have = new Map(rows.map((row) => [row.h, row]));
  const add = [];
  const drop = [];
  for (const [h, rec] of Object.entries(marks[space] ?? {})) {
    if (rec.deleted) {
      const local = have.get(h);
      if (local && local.deleted_at === null) drop.push(local.id);
      continue;
    }
    if (have.has(h)) continue;
    add.push({
      content: rec.content,
      category: rec.category || 'context',
      importance: Number(rec.importance ?? 3),
      tags: (rec.tags ?? []).slice(0, 20),
      entities: (rec.entities ?? []).slice(0, 50),
      source: rec.source || 'agent',
      created_at: rec.created_at || nowIso(),
    });
  }
  if (add.length) {
    const tmp = join(cfg.dataDir, 'state', 'kb-import-' + process.pid + '.json');
    writeFileSync(tmp, JSON.stringify({ schema_version: '1', exported_at: nowIso(), insights: add, edges: [] }), { mode: 0o600 });
    const imported = await sh(findMnemon(cfg), ['--data-dir', cfg.dataDir, '--store', space, 'import', tmp, '--no-diff'], { timeoutMs: 120000 });
    if (!imported.ok) log?.('warn', 'import ' + space + ': ' + imported.stderr.slice(0, 200));
  }
  for (const id of drop) await sh(findMnemon(cfg), ['--data-dir', cfg.dataDir, '--store', space, 'forget', id], {});
  return { space, imported: add.length, forgotten: drop.length };
}

/* ----------------------------------------------------------------- export */

async function exportSpace(cfg, state, space, marks, log) {
  const db = join(cfg.dataDir, 'data', space, 'mnemon.db');
  if (!existsSync(db)) return { space, exported: 0 };
  const rows = readLocalInsights(db);
  if (!rows) { log?.('warn', 'node:sqlite 不可用，跳过导出'); return { space, exported: 0 }; }
  const dir = join(state.repoDir, 'spaces', space);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metaFile = join(dir, 'space.json');
  if (!existsSync(metaFile)) {
    const reg = safeJson(existsSync(join(cfg.dataDir, 'data', '.dsh-memory-bodies.json')) ? readFileSync(join(cfg.dataDir, 'data', '.dsh-memory-bodies.json'), 'utf8') : '') ?? { bodies: [] };
    const body = (reg.bodies ?? []).find((item) => item.id === space) ?? {};
    writeFileSync(metaFile, JSON.stringify({ id: space, name: body.name || space, description: body.description || '' }, null, 2) + '\n');
  }
  const known = marks[space] ?? {};
  const shard = join(dir, state.device + '.jsonl');
  const pending = [];
  for (const row of rows) {
    if (row.deleted_at) {
      if (known[row.h] && !known[row.h].deleted) pending.push({ h: row.h, deleted: true, deleted_at: row.deleted_at });
      continue;
    }
    if (known[row.h]) continue;
    pending.push({ h: row.h, content: row.content, category: row.category, importance: row.importance, tags: row.tags, entities: row.entities, source: row.source, created_at: row.created_at });
  }
  if (pending.length) {
    const existing = existsSync(shard) ? readFileSync(shard, 'utf8') : '';
    writeFileSync(shard, existing + pending.map((rec) => JSON.stringify(rec)).join('\n') + '\n', { mode: 0o600 });
  }
  return { space, exported: pending.length };
}


/** 每次同步后写 devices/<device>.json，供 hub 面板统计设备与最近同步。 */
function writeHeartbeat(cfg, state, log) {
  try {
    const dir = join(state.repoDir, 'devices');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let head = '';
    try { head = execFileSync('git', ['-C', state.repoDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
    const body = {
      device: state.device,
      host: hostname(),
      lastSync: state.lastSync ?? nowIso(),
      head,
      platform: process.platform,
      version: cfg.pluginVersion ?? '0.7.2',
    };
    writeFileSync(join(dir, state.device + '.json'), JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  } catch (error) { log?.('warn', 'heartbeat: ' + (error?.message ?? error)); }
}

/* ------------------------------------------------------------------- sync */

async function syncAll(cfg, state, log, { pullOnly = false } = {}) {
  const ready = await ensureRepo(cfg, state, log);
  if (!ready.ok) return { ok: false, detail: ready.reason ?? 'repo 不可用' };
  const pulled = await git(cfg, state, ['pull', '--rebase', '--autostash']);
  try {
    const notifyFile = join(state.repoDir, 'notify.json');
    if (existsSync(notifyFile) && !state.notify?.url) {
      const discovered = safeJson(readFileSync(notifyFile, 'utf8'));
      if (discovered?.url) { state.notify = { url: String(discovered.url), token: String(discovered.token ?? '') }; writeState(cfg, state); }
    }
  } catch { /* best effort */ }
  const marks = repoMarks(state.repoDir);
  const localSpaces = listLocalSpaces(cfg);
  const applied = [];
  const exported = [];
  for (const space of Object.keys(marks)) {
    const policy = spacePolicy(state, space);
    if (policy.mode !== 'cloud' || !policy.enabled) continue;
    applied.push(await applySpace(cfg, state, space, marks, log));
  }
  if (!pullOnly) {
    for (const space of Object.keys(localSpaces)) {
      const policy = spacePolicy(state, space);
      if (policy.mode !== 'cloud' || !policy.enabled) continue;
      exported.push(await exportSpace(cfg, state, space, marks, log));
    }
    await git(cfg, state, ['add', '-A']);
    const status = await git(cfg, state, ['status', '--porcelain']);
    const changed = Boolean(status.ok && status.stdout.trim());
    // 心跳最多每 30 分钟刷一次，避免「只改时间戳」的提交把通知链打成死循环
    const lastBeat = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : 0;
    const beatDue = !lastBeat || Date.now() - lastBeat > 30 * 60 * 1000;
    let pushed = false;
    if (changed || beatDue) {
      writeHeartbeat(cfg, state, log);
      await git(cfg, state, ['add', '-A']);
      const staged = await git(cfg, state, ['status', '--porcelain']);
      if (staged.ok && staged.stdout.trim()) {
        await git(cfg, state, ['commit', '-m', 'kb-sync: ' + state.device + ' @ ' + nowIso()]);
        const push = await git(cfg, state, ['push', '-u', 'origin', 'HEAD']);
        pushed = push.ok;
        if (!push.ok) log?.('warn', 'push failed: ' + push.stderr.slice(0, 200));
      }
      state.lastHeartbeatAt = nowIso();
    }
    state.lastSync = nowIso();
    writeState(cfg, state);
    return { ok: true, pulled: pulled.ok, imported: applied.reduce((sum, item) => sum + item.imported, 0), exported: exported.reduce((sum, item) => sum + item.exported, 0), pushed, spaces: applied.length };
  }
  state.lastSync = nowIso();
  writeState(cfg, state);
  return { ok: true, pulled: pulled.ok, imported: applied.reduce((sum, item) => sum + item.imported, 0), spaces: applied.length, pullOnly: true };
}

/* ------------------------------------------------------------------ plugin */



const looksLikeUrl = (value) => /^(ssh|https?):\/\//i.test(String(value || '').trim());
function buildRemote(cfg, input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (looksLikeUrl(raw)) return raw;
  const path = String(cfg.hubPath || '/home/mnemon/mnemon-sync.git').replace(/^\/+/, '');
  const user = cfg.hubUser || 'mnemon';
  return 'ssh://' + user + '@' + raw + '/' + path;
}
function parseHost(remote) {
  const m = /^(?:ssh|https?):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(String(remote || ''));
  return m ? m[1] : '';
}

/* ------------------------------------------------------------------ api */
// 极简只读/写配置接口，给插件设置页用（127.0.0.1，非 UI）
function startStatusApi(cfg, deps) {
  const { readState, writeState, syncAll, log } = deps;
  const state = () => readState(cfg);
  const server = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': 'http://127.0.0.1:3080',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    };
    const send = (code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/kb/config') {
        const s = state();
        return send(200, {
          remote: s.remote || '',
          host: parseHost(s.remote),
          device: s.device || deps.hostname(),
          defaultDevice: deps.hostname(),
          lastSync: s.lastSync || null,
          configured: Boolean(s.remote),
          syncing: Boolean(deps.isRunning?.()),
        });
      }
      if (req.method === 'POST' && url.pathname === '/kb/config') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        const s = state();
        if (typeof body.host === 'string') s.remote = buildRemote(cfg, body.host);
        else if (typeof body.remote === 'string') s.remote = body.remote.trim();
        if (typeof body.device === 'string') s.device = body.device.trim();
        writeState(cfg, s);
        const result = await syncAll(cfg, state(), log);
        return send(200, { ok: result.ok !== false, result });
      }
      return send(404, { ok: false, detail: 'not found' });
    } catch (error) {
      log?.('warn', 'api: ' + (error?.message ?? error));
      return send(500, { ok: false, detail: String(error?.message ?? error) });
    }
  });
  server.listen(Number(cfg.apiPort) || 7394, '127.0.0.1');
  server.unref?.();
  return server;
}

export function apply(ctx, config = {}) {
  const log = (level, message) => {
    try {
      const logger = ctx?.logger;
      if (logger && typeof logger[level] === 'function') logger[level]('[kb-sync] ' + message);
      else if (level === 'error') console.error('[kb-sync]', message);
    } catch { /* never break the host */ }
  };

  let cfg;
  try { cfg = { ...DEFAULTS, ...(config ?? {}) }; } catch (error) { log('error', 'config: ' + error); return; }
  console.error('[kb-sync] plugin loaded, dataDir=' + cfg.dataDir);

  let running = false;

  async function withLock(fn) {
    if (running) return { ok: false, detail: '同步进行中，稍后再试' };
    running = true;
    try { return await fn(); } catch (error) { return { ok: false, detail: String(error?.message ?? error) }; } finally { running = false; }
  }

  const isRunning = () => running;
  const tool = (definition) => {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? {}).slice(0, 8000) }],
      },
      async execute(args) { return definition.execute(args ?? {}); },
    });
  };

  try {
    tool({
      name: 'kb_status',
      description: '共享知识库状态：remote/设备名、每个记忆空间的 mode(local|cloud)、enabled、本机条数与仓库条数、上次同步时间。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        const state = readState(cfg);
        const marks = existsSync(state.repoDir) ? repoMarks(state.repoDir) : {};
        const local = listLocalSpaces(cfg);
        const spaces = [];
        for (const space of new Set([...Object.keys(local), ...Object.keys(marks)])) {
          const policy = spacePolicy(state, space);
          const rows = local[space] ? readLocalInsights(local[space]) ?? [] : [];
          const live = rows.filter((row) => !row.deleted_at);
          const want = new Set(Object.entries(marks[space] ?? {}).filter(([, rec]) => !rec.deleted).map(([h]) => h));
          const have = new Set(live.map((row) => row.h));
          spaces.push({ space, mode: policy.mode, enabled: policy.enabled, local: have.size, remote: want.size, missingLocal: [...want].filter((h) => !have.has(h)).length, onlyLocal: [...have].filter((h) => !want.has(h)).length });
        }
        return { ok: true, remote: state.remote, device: state.device, repoDir: state.repoDir, lastSync: state.lastSync, spaces };
      },
    });

    tool({
      name: 'kb_sync',
      description: '立即同步：拉取云端记忆 → 应用新条目 → 导出本机 cloud 空间 → commit → push。返回导入/导出条数与是否推送。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return withLock(() => syncAll(cfg, readState(cfg), log)); },
    });

    tool({
      name: 'kb_pull',
      description: '只拉取并应用云端新记忆，不推送本机改动。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return withLock(() => syncAll(cfg, readState(cfg), log, { pullOnly: true })); },
    });

    tool({
      name: 'kb_space',
      description: '管理记忆空间：list 列出；create 新建（mode=local|cloud）；mode 改同步模式；enable/disable 开关同步。local 空间永不上传。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', description: 'list | create | mode | enable | disable', required: true },
          space: { type: 'string', description: '记忆空间 id' },
          mode: { type: 'string', description: 'cloud（默认，双向同步）或 local（只留本机）' },
          name: { type: 'string', description: 'create 时的显示名' },
          description: { type: 'string', description: 'create 时的路由说明' },
        },
      },
      async execute(args) {
        const state = readState(cfg);
        const action = String(args.action ?? '').toLowerCase();
        const space = String(args.space ?? '').trim();
        if (action === 'list') {
          return { ok: true, spaces: Object.keys(state.spaces).map((id) => ({ space: id, ...spacePolicy(state, id) })) };
        }
        if (!space) return { ok: false, detail: '缺少 space' };
        if (action === 'create') {
          const mode = args.mode === 'local' ? 'local' : 'cloud';
          const created = await sh(findMnemon(cfg), ['--data-dir', cfg.dataDir, 'store', 'create', space], {});
          registerLocalSpace(cfg, space, { name: args.name, description: args.description });
          state.spaces[space] = { mode, enabled: true };
          writeState(cfg, state);
          return { ok: created.ok || existsSync(join(cfg.dataDir, 'data', space, 'mnemon.db')), space, mode, detail: created.ok ? 'created' : created.stderr.slice(0, 200) };
        }
        if (action === 'mode') {
          if (args.mode !== 'local' && args.mode !== 'cloud') return { ok: false, detail: 'mode 只能是 local 或 cloud' };
          state.spaces[space] = { ...(state.spaces[space] ?? {}), mode: args.mode };
          writeState(cfg, state);
          return { ok: true, space, mode: args.mode };
        }
        if (action === 'enable' || action === 'disable') {
          state.spaces[space] = { ...(state.spaces[space] ?? {}), enabled: action === 'enable' };
          writeState(cfg, state);
          return { ok: true, space, enabled: action === 'enable' };
        }
        return { ok: false, detail: '未知 action: ' + action };
      },
    });

    tool({
      name: 'kb_config',
      description: '查看或设置知识库：remote（服务器地址，ssh:// 或 https://）、device（本机分片名）、intervalMinutes。设 remote 后会自动克隆并首次拉取。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', description: 'get | set', required: true },
          remote: { type: 'string', description: 'git 远端地址，如 ssh://user@host/path/repo.git 或 https://host/path/repo.git' },
          device: { type: 'string', description: '本机在仓库中的分片名' },
          intervalMinutes: { type: 'number', description: '全量同步间隔（分钟）' },
          branch: { type: 'string', description: '分支名，默认 main' },
        },
      },
      async execute(args) {
        const state = readState(cfg);
        if ((args.action ?? 'get') === 'get') return { ok: true, remote: state.remote, device: state.device, intervalMinutes: state.intervalMinutes, repoDir: state.repoDir, lastSync: state.lastSync };
        if (typeof args.remote === 'string' && args.remote.trim()) state.remote = args.remote.trim();
        if (typeof args.device === 'string' && args.device.trim()) state.device = args.device.trim();
        if (Number.isFinite(Number(args.intervalMinutes))) state.intervalMinutes = Math.max(5, Number(args.intervalMinutes));
        if (typeof args.branch === 'string' && args.branch.trim()) state.branch = args.branch.trim();
        writeState(cfg, state);
        if (!state.remote) return { ok: true, saved: true, detail: 'remote 为空，暂不同步' };
        const first = await withLock(() => syncAll(cfg, readState(cfg), log));
        return { ok: first.ok !== false, saved: true, firstSync: first };
      },
    });
  } catch (error) { log('error', 'register: ' + (error?.message ?? error)); }

  try {
    ctx.inject(['systemPrompt'], (prompted) => {
      prompted.get('systemPrompt').section({
        name: 'kb-sync',
        order: cfg.promptOrder,
        text: '[共享知识库] mnemon 记忆空间可跨设备同步：kb_status 看每个空间是 local 还是 cloud；kb_space 可新建空间/切模式/开关同步（local 只留本机，cloud 双向）。写入 cloud 空间后约半分钟自动推送，对端会在下次同步时拿到。',
      });
    });
  } catch (error) { log('warn', 'prompt: ' + (error?.message ?? error)); }

  // 设置页用的极简配置接口（127.0.0.1，不提供 UI）
  let apiServer;
  try { apiServer = startStatusApi(cfg, { readState, writeState, syncAll, log, isRunning, hostname }); }
  catch (error) { log('warn', 'api start: ' + (error?.message ?? error)); }

  // ── 事件驱动：写入即推；hub 一收到推送就长轮询通知各端 ──────────────
  const writeTools = new Set([
    'mnemon_remember', 'mnemon_forget', 'mnemon_link',
    'mnemon_memory_body_create', 'mnemon_memory_body_update', 'mnemon_memory_body_merge',
    'mnemon_document_create', 'mnemon_document_manage',
  ]);
  let pushDebounce;
  const schedulePush = (delaySeconds = 1.5) => {
    clearTimeout(pushDebounce);
    pushDebounce = setTimeout(() => {
      withLock(() => syncAll(cfg, readState(cfg), log)).then((result) => {
        if (result?.ok === false) log('warn', 'push: ' + result.detail);
      });
    }, Math.max(0.5, delaySeconds) * 1000);
    pushDebounce.unref?.();
  };
  try {
    ctx.tools.guard((exec) => {
      const toolName = exec?.name;
      if (typeof toolName === 'string' && writeTools.has(toolName)) schedulePush(3);
      return undefined;
    });
  } catch (error) { log('warn', 'guard hook: ' + (error?.message ?? error)); }
  try {
    ctx.on('tools/result', (exec) => {
      const toolName = exec?.name;
      if (typeof toolName === 'string' && writeTools.has(toolName)) schedulePush(1.5);
    });
  } catch (error) { log('warn', 'write hook: ' + (error?.message ?? error)); }

  // 文件系统事件（不是轮询）：容器内任何进程写 mnemon.db / -wal（CLI、别的插件、迁移脚本）
  // 都当成一次"写入"，去抖后推送。recursive watch 由 inotify 驱动，空闲时零开销。
  let fileWatcher;
  try {
    const watchRoot = join(cfg.dataDir, 'data');
    mkdirSync(watchRoot, { recursive: true, mode: 0o700 });
    if (existsSync(watchRoot)) {
      fileWatcher = watch(watchRoot, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (!/mnemon\.db(-wal)?$/.test(name)) return;
        const space = name.split('/')[0];
        if (!space) return;
        const state = readState(cfg);
        const policy = spacePolicy(state, space);
        if (policy.mode !== 'cloud' || !policy.enabled) return;
        schedulePush(1.5);
      });
      fileWatcher.unref?.();
    }
  } catch (error) { log('warn', 'fs watch: ' + (error?.message ?? error)); }

  let stopped = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const notifyLoop = async () => {
    let backoff = 2000;
    while (!stopped) {
      const state = readState(cfg);
      const notifyUrl = state.notify?.url;
      if (!state.remote || !notifyUrl) { await sleep(30000); continue; }
      try {
        const rev = (await git(cfg, state, ['rev-parse', 'HEAD'])).stdout.trim();
        const base = notifyUrl.replace(/\/+$/, '');
        const url = base + '/wait?rev=' + encodeURIComponent(rev) + '&token=' + encodeURIComponent(state.notify?.token ?? '');
        const payload = await httpJson(url, 70000);
        if (payload?.changed) {
          const result = await withLock(() => syncAll(cfg, readState(cfg), log));
          if (result?.ok === false) log('warn', 'notify pull: ' + result.detail);
        }
        backoff = 2000;
      } catch (error) {
        log('warn', 'notify loop: ' + (error?.message ?? error));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  };

  const fallback = setInterval(() => {
    withLock(() => syncAll(cfg, readState(cfg), log)).catch(() => {});
  }, Math.max(5, Number(cfg.intervalMinutes)) * 60 * 1000);
  fallback.unref?.();

  try {
    setTimeout(() => {
      withLock(() => syncAll(cfg, readState(cfg), log)).catch(() => {});
    }, 5_000).unref?.();
    notifyLoop().catch((error) => log('warn', 'notify loop died: ' + (error?.message ?? error)));
  } catch (error) { log('warn', 'event loop: ' + (error?.message ?? error)); }

  try {
    const cleanup = () => { stopped = true; clearTimeout(pushDebounce); clearInterval(fallback); try { apiServer?.close(); } catch {} try { fileWatcher?.close(); } catch {} };
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup, 'kb-sync notify');
  } catch { /* ignore */ }
}
