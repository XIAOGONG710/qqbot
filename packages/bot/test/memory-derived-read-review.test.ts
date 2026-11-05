import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LongTermMemory } from '../src/memory/long-term.ts';
import type { HindsightApi, RecallResult } from '../src/memory/hindsight.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import { fileOps } from '../src/memory/json-file.ts';
const now = new Date('2026-11-05T12:00:00Z'), A = { qq: 10001, tier: 'boyfriend', name: 'Synthetic A' }, B = { qq: 10002, tier: 'classmate', name: 'Synthetic B' };
const names = { char: 'Synthetic Character', user: A.name }, marker = 'SYNTHETIC_WITHDRAWN_DERIVED';
const message = (content = marker): StoredMessage => ({ role: 'user', content, time: '2026-11-04T12:00:00Z', messageId: 1 });
const redacted = (): StoredMessage[] => [{ ...message('[撤回了一条消息]'), recalled: true } as StoredMessage];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, '合成等待超时'); await tick(); } }
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-derived-read-')); let modelReads = 0, entityReads = 0, result: RecallResult[] = [];
 const api: HindsightApi = { putBank: async () => {}, retain: async () => {}, recall: async () => result,
  getMentalModel: async (bank, id) => { modelReads++; return { id, content: bank.endsWith('-common') ? marker : 'SYNTHETIC_PRIVATE_MODEL' }; },
  createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '', listEntities: async () => { entityReads++; return [marker]; },
  getDocument: async () => ({ original_text: `title\n${marker}` }) };
 const create = () => new LongTermMemory({ api, dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now.getTime(), log() {} });
 const memory = create();
 return { dir, api, memory, create, setResult: (value: RecallResult[]) => { result = value; }, modelReads: () => modelReads, entityReads: () => entityReads };
}
async function prime(f: ReturnType<typeof fixture>) { await f.memory.sync(A, names, [message()]); await f.memory.sync(B, { ...names, user: B.name }, [message('safe B')]); }
function note(memory: LongTermMemory, contact = A, snapshot?: StoredMessage[]) {
 const api = memory as LongTermMemory & { noteRecall?: (contact: typeof A, snapshot?: StoredMessage[]) => void };
 assert.equal(typeof api.noteRecall, 'function'); api.noteRecall!(contact, snapshot);
}
const query = [{ role: 'user' as const, content: '合成查询' }];

test('同步noteRecall在任何await前阻旧缓存和第三人公共模型，其他私人bank保留并跨重启', async () => {
 const f = fixture();
 try {
  await prime(f); f.memory.relationship(A); f.memory.relationship(B); f.memory.impression(B); await tick(); await f.memory.commonEntities();
  assert.ok(f.memory.impression(B)?.includes(marker)); assert.ok(f.memory.relationship(B));
  note(f.memory, A, redacted()); assert.equal(f.memory.relationship(A), undefined); assert.equal(f.memory.impression(B), undefined); assert.ok(f.memory.relationship(B));
  const count = f.entityReads(); assert.deepEqual(await f.memory.commonEntities(), []); assert.equal(f.entityReads(), count); assert.equal(await f.memory.readDiary('2026-11-04'), undefined);
  const restarted = f.create(); assert.equal(restarted.relationship(A), undefined); assert.equal(restarted.impression(B), undefined); assert.deepEqual(await restarted.commonEntities(), []);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('脏bank只保留明确未污染的原始world/experience，屏观察未知来源和日记周记', async () => {
 const f = fixture();
 try {
  await prime(f); const state = JSON.parse(readFileSync(join(f.dir, '10001-boyfriend.json'), 'utf8')); const own = Object.keys(state.retained)[0]!;
  const owner = f.memory.bankId(A).split('-').at(-1)!, other = f.memory.bankId(B).split('-').at(-1)!;
  note(f.memory, A, redacted());
  f.setResult([{ id: 'bad', text: marker, type: 'world', document_id: own }, { id: 'obs', text: marker, type: 'observation' }, { id: 'unknown', text: marker },
   { id: 'safe', text: 'SAFE_PRIVATE_FACT', type: 'experience', document_id: 'ep-1' }]);
  const privateText = await f.memory.recall(A, query, now); assert.match(privateText!, /SAFE_PRIVATE_FACT/); assert.doesNotMatch(privateText!, /SYNTHETIC_WITHDRAWN/);
  f.setResult([{ id: 'bad', text: marker, type: 'world', document_id: `${owner}:${own}` }, { id: 'diary', text: marker, type: 'world', document_id: 'diary:2026-11-04' },
   { id: 'safe', text: 'SAFE_OTHER_FACT', type: 'experience', document_id: `${other}:ep-1` }]);
  const shared = await f.memory.recallCommon(A, query, now, [A, B]); assert.match(shared!, /SAFE_OTHER_FACT/); assert.doesNotMatch(shared!, /SYNTHETIC_WITHDRAWN/);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('snapshot未知只屏本owner原始文档，不封其他owner；已给无recalled的snapshot不脏化正常boot', async () => {
 const f = fixture();
 try {
  await prime(f); note(f.memory, A, [message()]); f.memory.relationship(A); await tick(); assert.ok(f.memory.relationship(A));
  note(f.memory); const a = f.memory.bankId(A).split('-').at(-1)!, b = f.memory.bankId(B).split('-').at(-1)!;
  f.setResult([{ id: 'a', text: marker, type: 'world', document_id: `${a}:ep-1` }, { id: 'b', text: 'OTHER_OWNER_OK', type: 'world', document_id: `${b}:ep-1` }]);
  const output = await f.memory.recallCommon(A, query, now, [A, B]); assert.match(output!, /OTHER_OWNER_OK/); assert.doesNotMatch(output!, /SYNTHETIC_WITHDRAWN/);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('revision由sync入口同步持久，旧count迁移或legacy遮盖不能到微任务后才阻model', async () => {
 const f = fixture();
 try {
  await prime(f); f.memory.relationship(A); f.memory.impression(B); await tick();
  const task = f.memory.sync(A, names, redacted()); assert.equal(f.memory.relationship(A), undefined); assert.equal(f.memory.impression(B), undefined); await task;
  const store = new DerivedState(f.dir); assert.equal(store.snapshot(f.memory.bankId(A)).dirty, true); assert.equal(store.snapshot(f.memory.commonBankId()).dirty, true);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('在途模型实体召回返回前新dirty也不能提交旧正文', async () => {
 const f = fixture(); const held = gate<RecallResult[]>(), entities = gate<string[]>(), models = gate<{ id: string; content: string }>();
 try {
  await prime(f); f.api.recall = async () => held.promise; f.api.listEntities = async () => entities.promise; f.api.getMentalModel = async () => models.promise;
  f.memory.impression(B); const entityTask = f.memory.commonEntities(), recallTask = f.memory.recall(A, query, now);
  note(f.memory, A, redacted()); models.release({ id: 'x', content: marker }); entities.release([marker]); held.release([{ id: 'x', text: marker, type: 'observation' }]);
  assert.equal(await recallTask, undefined); assert.deepEqual(await entityTask, []); await tick(); assert.equal(f.memory.impression(B), undefined);
 } finally { held.release([]); entities.release([]); models.release({ id: 'x', content: '' }); await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('week二次召回等待期间新撤回会重新过滤先前结果，othersToday保留其他来源干净事实', async () => {
 const f = fixture(); const held = gate<RecallResult[]>(); let reads = 0;
 try {
  await prime(f); f.api.recall = async () => { reads++; return reads === 1 ? [{ id: 'old', text: marker, type: 'world', document_id: 'diary:2026-10-28', mentioned_at: '2026-10-28T12:00:00Z' }] : held.promise; };
  const request = f.memory.recallCommon(B, query, now, [A, B], { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z'), period: 'week' });
  await until(() => reads >= 2); note(f.memory, A, redacted()); held.release([{ id: 'week', text: marker, type: 'world', document_id: 'week:2026-10-26', mentioned_at: '2026-11-01T12:00:00Z' }]);
  assert.equal(await request, undefined);
  const C = { qq: 10003, tier: 'classmate', name: 'Synthetic C' }, a = f.memory.bankId(A).split('-').at(-1)!, c = f.memory.bankId(C).split('-').at(-1)!;
  const sourceId = Object.keys(JSON.parse(readFileSync(join(f.dir, '10001-boyfriend.json'), 'utf8')).retained)[0]!;
  f.api.recall = async () => [{ id: 'old-a', text: marker, type: 'world', document_id: `${a}:${sourceId}`, mentioned_at: now.toISOString() },
   { id: 'clean-c', text: 'SAFE_TODAY_C', type: 'experience', document_id: `${c}:ep-1`, mentioned_at: now.toISOString() }];
  const today = await f.memory.othersToday(B, now, [A, B, C], new Date('2026-11-05T00:00:00Z')); assert.match(today!, /SAFE_TODAY_C/); assert.doesNotMatch(today!, /SYNTHETIC_WITHDRAWN/);
 } finally { held.release([]); await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('最终format回调中新接受的撤回也不能让旧观察作为返回值流出', async () => {
 const f = fixture();
 try { await prime(f); f.setResult([{ id: 'obs', text: marker, type: 'observation' }]);
  const output = await f.memory.recall(A, query, now, { onFade: () => note(f.memory, A, redacted()) }); assert.equal(output, undefined);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('坏集中屏障保原件并阻模型及原始召回，不以旧cache或初始clean兜底', async () => {
 const f = fixture();
 try { await prime(f); f.memory.impression(B); await tick(); writeFileSync(join(f.dir, 'derived.json'), '{"SYNTHETIC_PRIVATE_BROKEN":');
  const count = f.modelReads(); assert.equal(f.memory.impression(B), undefined); assert.equal(f.modelReads(), count); assert.equal(f.memory.relationship(A), undefined);
  f.setResult([{ id: 'x', text: marker, type: 'world', document_id: 'ep-1' }]); assert.equal(await f.memory.recall(A, query, now), undefined); assert.deepEqual(await f.memory.commonEntities(), []);
  assert.equal(readFileSync(join(f.dir, 'derived.json'), 'utf8'), '{"SYNTHETIC_PRIVATE_BROKEN":');
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('双bank标记持久化失败时RAM保留两侧delta，恢复后重启仍挡第三人公共模型', async () => {
 const f = fixture(), original = fileOps.writeFileSync;
 try { await prime(f); f.memory.impression(B); f.memory.relationship(A); await tick();
  fileOps.writeFileSync = ((...args: Parameters<typeof original>) => { if (String(args[0]).includes('derived.json.tmp-')) throw new Error('synthetic unavailable'); return original(...args); }) as typeof original;
  assert.throws(() => note(f.memory, A, redacted()), /派生修订观察/);
  assert.equal(f.memory.relationship(A), undefined); assert.equal(f.memory.impression(B), undefined); assert.deepEqual(await f.memory.commonEntities(), []);
  fileOps.writeFileSync = original; assert.equal(f.memory.impression(B), undefined);
  const restart = f.create(); assert.equal(restart.impression(B), undefined); assert.equal(restart.relationship(A), undefined);
 } finally { fileOps.writeFileSync = original; await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('noteRecall持久标记失败仍立刻失效旧sync，不能在恢复ACK后继续retain旧快照', async () => {
 const f = fixture(), original = fileOps.writeFileSync, held = gate<void>(); let begun = false, retains = 0;
 f.api.putBank = async () => { if (!begun) { begun = true; await held.promise; } }; f.api.retain = async () => { retains++; };
 f.memory.derivedAvailable(); const task = f.memory.sync(A, names, [message()]);
 try { await until(() => begun);
  fileOps.writeFileSync = ((...args: Parameters<typeof original>) => { if (String(args[0]).includes('derived.json.tmp-')) throw new Error('synthetic unavailable'); return original(...args); }) as typeof original;
  assert.throws(() => note(f.memory, A, redacted())); fileOps.writeFileSync = original; held.release(); await task; assert.equal(retains, 0);
 } finally { fileOps.writeFileSync = original; held.release(); await task; await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('derived写派发前及ensureBank等待后重新核对，但已在途retain ACK仍记为成功', async () => {
 const f = fixture(), heldBank = gate<void>(), heldRetain = gate<void>(); let begun = false, retains = 0;
 f.api.putBank = async () => { begun = true; await heldBank.promise; }; f.api.retain = async () => { retains++; await heldRetain.promise; };
 let first: Promise<boolean> | undefined;
 try {
  first = f.memory.retainDiary('2026-11-04', now, 'SYNTHETIC_DIARY', names.char); await until(() => begun); note(f.memory, A, redacted()); heldBank.release(); assert.equal(await first, false); assert.equal(retains, 0);
  assert.equal(f.memory.derivedAvailable(), false); assert.equal(await f.memory.retainSummary('week:2026-10-26', now, 'title', 'text', names.char, 'week'), false);
 } finally { heldBank.release(); heldRetain.release(); await first; await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
 const other = fixture(), secondAck = gate<void>(); let started = false;
 other.api.retain = async () => { started = true; await secondAck.promise; };
 const writing = other.memory.retainDiary('2026-11-04', now, 'SYNTHETIC_DIARY', names.char);
 try { await until(() => started); note(other.memory, A, redacted()); secondAck.release(); assert.equal(await writing, true); assert.equal(other.memory.status().lastWrite?.ok, true); }
 finally { secondAck.release(); await writing; await other.memory.stop(); rmSync(other.dir, { recursive: true, force: true }); }
});
