import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMenuFrom } from '../src/life/menu.ts';
import { loadEverydayFrom } from '../src/life/everyday.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { TransientStateError } from '../src/memory/transient-io.ts';

for (const [name, load] of [['菜单', loadMenuFrom], ['日常', loadEverydayFrom]] as const) {
 const fixture = (run: (path: string, dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-activation-')); try { run(join(dir, 'from.json'), dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
 test(name + '既有坏形状或不存在日期失败关闭，不重算历史锚点', () => fixture((path, dir) => {
  for (const bad of [null, [], {}, { version: 2, from: '2026-11-01' }, { version: 1 }, { version: 1, from: 1 }, { version: 1, from: '2026-02-30' }, { version: 1, from: '0099-02-29' }, { version: 1, from: '10000-01-01' }]) {
   const raw = JSON.stringify(bad); writeFileSync(path, raw);
   assert.throws(() => load(path, new Date('2026-11-05T12:00:00')));
   assert.equal(readFileSync(path, 'utf8'), raw);
   assert.deepEqual(readdirSync(dir), ['from.json']);
  }
 }));
 test(name + '坏JSON在普通日与年末保持原文件，错误和日志不泄漏正文', () => fixture((path, dir) => {
  for (const now of ['2026-11-05T12:00:00', '9999-12-31T12:00:00']) {
   const raw = '{"PRIVATE_ACTIVATION_MARKER"'; const logs: string[] = []; writeFileSync(path, raw);
   assert.throws(() => load(path, new Date(now), message => logs.push(message)), error => error instanceof Error && !error.message.includes('PRIVATE_ACTIVATION_MARKER'));
   assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(dir), ['from.json']);
   assert.ok(logs.every(message => !message.includes('PRIVATE_ACTIVATION_MARKER')));
  }
 }));
 test(name + '合法旧锚点含低年闰日及未知扩展，普通日和年末原样保留', () => fixture((path, dir) => {
  for (const from of ['0000-02-29', '0096-02-29', '2026-11-01', '9999-12-31']) {
   const raw = JSON.stringify({ version: 1, from, futureExtension: true }); writeFileSync(path, raw);
   for (const now of ['2026-11-05T12:00:00', '9999-12-31T12:00:00']) assert.equal(load(path, new Date(now)), from);
   assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(dir), ['from.json']);
  }
 }));
 test(name + '不存在时依旧从明天启用并持久化', () => fixture(path => {
  assert.equal(load(path, new Date('2026-11-05T12:00:00')), '2026-11-06');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { version: 1, from: '2026-11-06' });
 }));
 test(name + '瞬时读取故障原样传递且不修改锚点', () => fixture((path, dir) => {
  const raw = JSON.stringify({ version: 1, from: '2026-11-01' }); writeFileSync(path, raw);
  const original = fileOps.readFileSync; const delays = fileOps.readDelaysMs;
  fileOps.readFileSync = (() => { throw Object.assign(new Error('synthetic'), { code: 'EMFILE' }); }) as typeof original;
  fileOps.readDelaysMs = [0];
  try { assert.throws(() => load(path, new Date('2026-11-05T12:00:00')), error => error instanceof TransientStateError); }
  finally { fileOps.readFileSync = original; fileOps.readDelaysMs = delays; }
  assert.equal(readFileSync(path, 'utf8'), raw); assert.deepEqual(readdirSync(dir), ['from.json']);
 }));
}
