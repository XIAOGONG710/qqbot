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

test('坏Contact进度形状隔离原件后稳定重写，不无限丢计数也不相信缺bank身份的计数', async () => {
 const cases: ((bankId: string) => unknown)[] = [() => null, () => [], () => ({}), () => ({ retained: { [splitEpisodes(history)[0]!.id]: 1 } }),
  bankId => ({ bankId, retained: [] }), ...[-1, 1e999, 0.1].map(count => (bankId: string) => ({ bankId, retained: { 'ep-1': count } })),
  bankId => ({ bankId, retained: {}, common: [] }), bankId => ({ bankId, retained: {}, relationshipModel: {} }), bankId => ({ bankId, retained: {}, bankConfigured: true })];
 for (const invalid of cases) {
  const f = fixture();
  try {
   const value = invalid(f.memory.bankId(contact));
   const text = JSON.stringify(value); writeFileSync(f.path, text);
   await f.memory.sync(contact, names, history); await f.memory.sync(contact, names, history);
   assert.equal(f.documents.length, 1);
   assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).retained[splitEpisodes(history)[0]!.id], 1);
   const corrupt = readdirSync(f.dir).find(file => file.startsWith('123-classmate.json.corrupt-')); assert.ok(corrupt);
   assert.equal(readFileSync(join(f.dir, corrupt), 'utf8'), text);
   assert.doesNotMatch(f.logs.join('\n'), /SYNTHETIC_PRIVATE/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
 }
});

test('合法旧版本boolean/字符串和扩展兼容，正常重启不重写已完成片段，换bank从头写', async () => {
 const f = fixture(true);
 try {
  writeFileSync(f.path, JSON.stringify({ bankId: f.memory.bankId(contact), retained: {}, bankConfigured: 'legacy-version', relationshipModel: true, extension: { kept: true } }));
  writeFileSync(join(f.dir, 'common.json'), JSON.stringify({ bankId: f.memory.commonBankId(), bankConfigured: 'legacy-version', extension: { kept: true } }));
  await f.memory.sync(contact, names, history);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).extension, { kept: true });
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'common.json'), 'utf8')).extension, { kept: true });
  const restart = new Memory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, log() {}, now: () => now });
  await restart.sync(contact, names, history); assert.equal(f.documents.length, 2);
  const changed = new Memory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'new-synthetic', recallTimeoutMs: 100, log() {}, now: () => now });
  await changed.sync(contact, names, history); assert.equal(f.documents.length, 4);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('Common坏schema通过所有召回及写入口隔离，不抛TypeError或把坏对象当已配置', async () => {
 const f = fixture(true);
 try {
  const path = join(f.dir, 'common.json');
  const chat = [{ role: 'user' as const, content: '合成查询' }];
  for (const bad of [null, [], { bankId: f.memory.commonBankId(), bankConfigured: true }]) {
   for (const action of [() => f.memory.recallCommon(contact, chat, new Date(now), [contact]), () => f.memory.othersToday(contact, new Date(now), [contact, { qq: 456, tier: 'classmate', name: 'Other' }], new Date(now - 3600_000))]) {
    writeFileSync(path, JSON.stringify(bad)); assert.equal(await action(), undefined);
   }
   writeFileSync(path, JSON.stringify(bad)); assert.equal(await f.memory.retainDiary('2026-11-04', new Date(now), 'SYNTHETIC_DIARY', names.char), true);
   assert.equal(JSON.parse(readFileSync(path, 'utf8')).bankId, f.memory.commonBankId());
  }
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
