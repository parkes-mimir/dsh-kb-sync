#!/usr/bin/env node
// kb-status —— 一眼看清插件是否在跑、同步到哪了
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

const require = createRequire(import.meta.url);
const DATA = process.env.MNEMON_DATA_DIR || join(homedir(), '.mnemon');
const statePath = join(DATA, 'state', 'kb-sync.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const repo = state.repoDir || join(DATA, 'state', 'kb-repo');
const dim = (s) => '\u001b[2m' + s + '\u001b[0m';
const ok = (s) => '\u001b[32m' + s + '\u001b[0m';
const warn = (s) => '\u001b[33m' + s + '\u001b[0m';
const bad = (s) => '\u001b[31m' + s + '\u001b[0m';

const git = (...args) => {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); } catch { return ''; }
};

console.log('== 插件');
let loaded = '';
try {
  loaded = execFileSync('bash', ['-c', "journalctl --user -u dsh-web.service --no-pager 2>/dev/null | grep -m1 '\\[kb-sync\\] plugin loaded' | tail -1"], { encoding: 'utf8' }).trim();
} catch {}
console.log(loaded ? ok('  已加载  ') + dim(loaded.replace(/^.*dsh\[\d+\]: /, '')) : bad('  日志里没找到 [kb-sync] plugin loaded（插件没挂上）'));

console.log('== 配置');
console.log('  remote    ' + (state.remote || bad('未配置')));
console.log('  device    ' + (state.device || '-'));
console.log('  repoDir   ' + repo + (existsSync(join(repo, '.git')) ? ok(' ✓') : bad(' ✗ 未克隆')));
console.log('  lastSync  ' + (state.lastSync || dim('从未')));

console.log('== 仓库');
const head = git('rev-parse', '--short', 'HEAD');
const lastMsg = git('log', '-1', '--format=%cI %s');
console.log('  HEAD      ' + (head || bad('空仓库')) + dim(lastMsg ? '  ' + lastMsg : ''));

console.log('== 空间');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
const marks = {};
const spacesRoot = join(repo, 'spaces');
if (existsSync(spacesRoot)) {
  for (const sp of readdirSync(spacesRoot, { withFileTypes: true })) {
    if (!sp.isDirectory()) continue;
    marks[sp.name] = new Map();
    for (const f of readdirSync(join(spacesRoot, sp.name))) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(spacesRoot, sp.name, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (!rec.h) continue;
          if (rec.deleted) marks[sp.name].set(rec.h, rec);
          else if (!marks[sp.name].has(rec.h)) marks[sp.name].set(rec.h, rec);
        } catch {}
      }
    }
  }
}
const policy = (id) => {
  const e = (state.spaces ?? {})[id] ?? {};
  return { mode: e.mode === 'local' ? 'local' : 'cloud', enabled: e.enabled !== false };
};
const dataRoot = join(DATA, 'data');
const localSpaces = existsSync(dataRoot) ? readdirSync(dataRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const all = [...new Set([...localSpaces, ...Object.keys(marks)])].sort();
console.log('  ' + ['space'.padEnd(14), 'mode', 'en', 'local', 'remote', 'missing'].join(' '));
for (const id of all) {
  const p = policy(id);
  const dbPath = join(dataRoot, id, 'mnemon.db');
  let have = new Set();
  if (existsSync(dbPath) && DatabaseSync) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const row of db.prepare('select content, deleted_at from insights').all()) {
        if (row.deleted_at) continue;
        const { createHash } = require('node:crypto');
        have.add(createHash('sha256').update(String(row.content), 'utf8').digest('hex').slice(0, 32));
      }
    } finally { db.close(); }
  }
  const want = new Set([...(marks[id] ?? new Map()).entries()].filter(([, r]) => !r.deleted).map(([h]) => h));
  const missing = [...want].filter((h) => !have.has(h)).length;
  const line = '  ' + id.padEnd(14) + ' ' + p.mode.padEnd(4) + ' ' + (p.enabled ? 'on ' : 'off') + ' ' +
    String(have.size).padStart(5) + ' ' + String(want.size).padStart(6) + ' ' + String(missing).padStart(7);
  console.log(missing > 0 ? warn(line) : line);
}

console.log('== 通知链路');
const notifyUrl = state.notify?.url;
if (!notifyUrl) {
  console.log('  ' + dim('未配置 notifyUrl（只能靠 intervalMinutes 兜底对账）'));
} else {
  const url = new URL('/health', notifyUrl);
  const req = http.get(url, { timeout: 4000 }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        const same = head && j.rev && j.rev.startsWith(head) || (head && j.rev === head);
        console.log('  hub ' + (same === false ? warn('rev=' + String(j.rev).slice(0, 8) + ' ≠ 本地 ' + head) : ok('rev 一致 ' + String(j.rev).slice(0, 8))));
      } catch { console.log('  ' + bad('hub 返回异常: ' + body.slice(0, 80))); }
      finish();
    });
  });
  req.on('timeout', () => { req.destroy(); console.log('  ' + bad('hub 超时')); finish(); });
  req.on('error', (e) => { console.log('  ' + bad('hub 不可达: ' + e.message)); finish(); });
}

function finish() {
  console.log('== 结论');
  const problems = [];
  if (!loaded) problems.push('插件未加载');
  if (!state.remote) problems.push('未配置 remote');
  if (!existsSync(join(repo, '.git'))) problems.push('仓库未克隆');
  if (problems.length) console.log('  ' + bad('需要处理：' + problems.join(' / ')));
  else console.log('  ' + ok('插件在跑，配置齐全；空间表的 missing 全为 0 即已同步'));
}
