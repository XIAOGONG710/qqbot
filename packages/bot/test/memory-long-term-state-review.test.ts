import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi } from '../src/memory/hindsight.ts';
import { splitEpisodes } from '../src/memory/episodes.ts';
import { fileOps } from '../src/memory/json-file.ts';

const Memory: typeof LongTermMemory = process.env.SYNTHETIC_LONG_TERM_MODULE
 ? (await import(process.env.SYNTHETIC_LONG_TERM_MODULE)).LongTermMemory : LongTermMemory;
const contact = { qq: 123, tier: 'classmate', name: 'Synthetic User' }, names = { char: 'Synthetic Character', user: contact.name };
const history = [{ role: 'user' as const, content: 'SYNTHETIC_PRIVATE', time: '2026-11-04T12:00:00Z', messageId: 1 }];
const now = Date.parse('2026-11-05T12:00:00Z');
function fixture(common = false) {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-long-term-state-')); const documents: string[] = [], logs: string[] = [];
 const api: HindsightApi = { putBank: async () => {}, retain: async (_bank, item) => { documents.push(item.document_id!); }, recall: async () => [], getMentalModel: async () => undefined,
  createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '' };
 const memory = new Memory({ api, dir, common, bankPrefix: 'synthetic', recallTimeoutMs: 100, log: message => logs.push(message), now: () => now });
 return { dir, memory, api, documents, logs, path: join(dir, '123-classmate.json') };
}

// 这三条原来是 main 的写法（坏进度改名成 .corrupt-* 隔离、用空进度继续写）。整合线保留 DSH 的策略（用户 2026-11-06 选定）：
// 坏进度失败关闭——不重写、不派发、原件不动，等人修复；读路径这一轮不带记忆，但不能抛错拖垮整轮回复。
const chatQuery = [{ role: 'user' as const, content: '合成查询' }];

test('坏Contact进度失败关闭：原件不动、不派发、不另起隔离副本；读路径这一轮不带记忆且不抛；修复后恢复', async () => {
 const cases: ((bankId: string) => unknown)[] = [() => null, () => [], () => ({}), () => ({ retained: { [splitEpisodes(history)[0]!.id]: 1 } }),
  bankId => ({ bankId, retained: [] }), ...[-1, 1e999, 0.1].map(count => (bankId: string) => ({ bankId, retained: { 'ep-1': count } })),
  bankId => ({ bankId, retained: {}, common: [] }), bankId => ({ bankId, retained: {}, relationshipModel: {} }), bankId => ({ bankId, retained: {}, bankConfigured: true })];
 for (const invalid of cases) {
  const f = fixture();
  try {
   const text = JSON.stringify(invalid(f.memory.bankId(contact))); writeFileSync(f.path, text);
   await f.memory.sync(contact, names, history); await f.memory.sync(contact, names, history);
   assert.equal(f.documents.length, 0, `坏进度不能派发：${text}`);
   assert.equal(readFileSync(f.path, 'utf8'), text, '原件一字不动');
   assert.equal(readdirSync(f.dir).some(file => file.includes('.corrupt-')), false, '不另起隔离副本（那是 main 的策略）');
   assert.equal(f.memory.status().lastWrite?.ok, false);
   assert.ok(f.memory.status().lastWrite?.error, '失败关闭要给出原因');
   assert.equal(await f.memory.recall(contact, chatQuery, new Date(now)), undefined, '召回这一轮不带记忆，不抛');
   assert.equal(f.memory.relationship(contact), undefined, '关系概况是同步调用，坏进度时不能抛（以前会让整轮回复失败）');
   assert.doesNotMatch(f.logs.join(' '), /SYNTHETIC_PRIVATE/);
   // 人修复（这里是删掉坏文件）后恢复写入
   rmSync(f.path); await f.memory.sync(contact, names, history);
   assert.equal(f.documents.length, 1, '修复后照常写入');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
 }
});

test('合法旧版本boolean/字符串兼容，正常重启不重写已完成片段，换bank从头写', async () => {
 // DSH 的写入按已知字段重写进度，不保留未知扩展字段（main 会保留）；这里只验证旧写法能读、不重复写。差异已记在 handoff。
 const f = fixture(true);
 try {
  writeFileSync(f.path, JSON.stringify({ bankId: f.memory.bankId(contact), retained: {}, bankConfigured: 'legacy-version', relationshipModel: true, extension: { kept: true } }));
  writeFileSync(join(f.dir, 'common.json'), JSON.stringify({ bankId: f.memory.commonBankId(), bankConfigured: 'legacy-version', extension: { kept: true } }));
  await f.memory.sync(contact, names, history); assert.equal(f.documents.length, 2, '旧写法能读：私人片段 + 公共片段各写一次');
  const restart = new Memory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, log() {}, now: () => now });
  await restart.sync(contact, names, history); assert.equal(f.documents.length, 2, '正常重启不重写已完成片段');
  const changed = new Memory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'new-synthetic', recallTimeoutMs: 100, log() {}, now: () => now });
  await changed.sync(contact, names, history); assert.equal(f.documents.length, 4, '换 bank 从头写');
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('Common坏schema：召回入口这一轮不带公共记忆且不抛；写日记失败关闭、原件不动；修复后恢复', async () => {
 const f = fixture(true);
 try {
  const path = join(f.dir, 'common.json');
  for (const bad of [null, [], { bankId: f.memory.commonBankId(), bankConfigured: true }]) {
   const text = JSON.stringify(bad);
   for (const action of [() => f.memory.recallCommon(contact, chatQuery, new Date(now), [contact]), () => f.memory.othersToday(contact, new Date(now), [contact, { qq: 456, tier: 'classmate', name: 'Other' }], new Date(now - 3600_000))]) {
    writeFileSync(path, text); assert.equal(await action(), undefined);
   }
   writeFileSync(path, text);
   assert.equal(await f.memory.retainDiary('2026-11-04', new Date(now), 'SYNTHETIC_DIARY', names.char), false, '坏公共进度不写日记（下次再试）');
   assert.equal(readFileSync(path, 'utf8'), text, '原件一字不动');
  }
  rmSync(path);
  assert.equal(await f.memory.retainDiary('2026-11-04', new Date(now), 'SYNTHETIC_DIARY', names.char), true, '修复后照常写');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).bankId, f.memory.commonBankId());
  assert.doesNotMatch(f.logs.join(' '), /SYNTHETIC_DIARY|SYNTHETIC_PRIVATE/);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('暂时IO失败不隔离、不覆盖有效进度，也不派发远端写入', async () => {
 const f = fixture(); const original = fileOps.readFileSync, delays = fileOps.readDelaysMs;
 try {
  const text = JSON.stringify({ bankId: f.memory.bankId(contact), retained: {} }); writeFileSync(f.path, text);
  fileOps.readDelaysMs = [0];
  fileOps.readFileSync = ((...args: Parameters<typeof original>) => { if (String(args[0]) === f.path) throw Object.assign(new Error('SYNTHETIC_PRIVATE'), { code: 'EACCES' }); return original(...args); }) as typeof original;
  await f.memory.sync(contact, names, history);
  assert.equal(f.documents.length, 0); assert.equal(readFileSync(f.path, 'utf8'), text);
  assert.deepEqual(readdirSync(f.dir), ['123-classmate.json']);
  fileOps.readFileSync = original;
  await f.memory.sync(contact, names, history); assert.equal(f.documents.length, 1);
 } finally { fileOps.readFileSync = original; fileOps.readDelaysMs = delays; rmSync(f.dir, { recursive: true, force: true }); }
});
