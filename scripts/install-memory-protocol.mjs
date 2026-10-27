#!/usr/bin/env node
// 把 presets/memory-protocol.md 写进本机 dsh profile 的 mnemon instruction（幂等、带备份）
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const profile = process.env.DSH_PROFILE || 'web';
const target = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');
if (!existsSync(target)) { console.error('找不到 profile 配置：' + target); process.exit(1); }

const md = readFileSync(join(here, '..', 'presets', 'memory-protocol.md'), 'utf8');
const body = md.split('---').slice(2).join('---').trim();
const text = readFileSync(target, 'utf8');
if (text.includes('★敏感信息只进本地空间')) { console.log('已存在，跳过'); process.exit(0); }

const anchor = '            instruction: |\n';
const idx = text.indexOf(anchor);
if (idx < 0) { console.error('profile 里没有 mnemon instruction 块，请手工粘贴 presets/memory-protocol.md'); process.exit(2); }

copyFileSync(target, target + '.bak-' + Date.now());
const indented = body.split('\n').map((line) => '              ' + line).join('\n') + '\n';
const end = text.indexOf('\n- id:', idx);
const next = text.slice(0, idx) + anchor + indented + text.slice(end);
writeFileSync(target, next);
console.log('已写入 ' + target + '（重启 dsh 生效）');
