import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LongTermMemory, OPEN_EPISODE_STEP } from '../src/memory/long-term.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import type { HindsightApi, MemoryItem } from '../src/memory/hindsight.ts';
import type { RetentionStatus } from '../src/memory/hindsight.ts';
import { fileOps } from '../src/memory/json-file.ts';
const now = Date.parse('2026-11-05T12:30:00Z'), contact = { qq: 10001, tier: 'classmate' }, names = { char: 'Synthetic Character', user: 'Synthetic User' };
const marker = 'SYNTHETIC_WITHDRAWN_SECRET';
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 2)); } }
function fixture(patch: Partial<HindsightApi> = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-revision-')), history = new ChatHistory(dir), documents = new Map<string, MemoryItem>(), writes: { bank: string; item: MemoryItem }[] = [];
 const api: HindsightApi = { putBank: async () => {}, retain: async (bank, item) => { writes.push({ bank, item: structuredClone(item) }); documents.set(`${bank}/${item.document_id}`, structuredClone(item)); },
  recall: async () => [], getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '', ...patch };
 const memory = new LongTermMemory({ api, dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
 for (let i = 0; i < OPEN_EPISODE_STEP; i++) history.append(contact.qq, { role: 'user', time: new Date(now - 15 * 60_000 + i * 1000).toISOString(), content: i === 15 ? marker : `synthetic ${i}`, messageId: i + 1 });
 return { dir, history, memory, api, documents, writes, path: join(dir, '10001-classmate.json') };
}

test('已提交的开放片段撤回后同count更新两库稳定文档，正常重启不重复提交', async () => {
 const f = fixture();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 2); const ids = [...f.documents.keys()];
  assert.equal(f.history.recall(contact.qq, 16), true); await f.memory.sync(contact, names, f.history.load(contact.qq));
  assert.equal(f.writes.length, 4); assert.deepEqual([...f.documents.keys()], ids);
  for (const item of f.documents.values()) { assert.ok(!item.content.includes(marker)); assert.ok(item.content.includes(RECALLED_TEXT)); }
  const restart = new LongTermMemory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
  await restart.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 4);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('正常新增不足30不重写，已提交前缀变化即使新增不足30也更新', async () => {
 const f = fixture();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq));
  f.history.append(contact.qq, { role: 'user', time: new Date(now - 14 * 60_000).toISOString(), content: 'one added', messageId: 31 });
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 2);
  f.history.recall(contact.qq, 16); await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 4);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('旧count没有提交摘要只重写一次建立证据，保留扩展且换bank重新提交', async () => {
 const f = fixture();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); const state = JSON.parse(readFileSync(f.path, 'utf8'));
  delete state.retainedDigests; delete state.commonDigests; state.extension = { kept: true }; writeFileSync(f.path, JSON.stringify(state));
  f.history.recall(contact.qq, 16); await f.memory.sync(contact, names, f.history.load(contact.qq)); await f.memory.sync(contact, names, f.history.load(contact.qq));
  assert.equal(f.writes.length, 4); assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).extension, { kept: true });
  const changed = new LongTermMemory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'other-synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
  await changed.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 6);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('建库held期间最新sync使旧快照失效，旧正文不再派发retain', async () => {
 const held = gate<void>(); let started = false; const f = fixture({ putBank: async () => { if (!started) { started = true; await held.promise; } } });
 const first = f.memory.sync(contact, names, f.history.load(contact.qq)); let second: Promise<void> | undefined;
 try {
  await until(() => started); f.history.recall(contact.qq, 16); second = f.memory.sync(contact, names, f.history.load(contact.qq)); held.release(); await Promise.all([first, second]);
  assert.equal(f.writes.length, 2); assert.ok(f.writes.every(row => !row.item.content.includes(marker)));
 } finally { held.release(); await Promise.allSettled([first, second]); await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('旧retain在途ACK保存实际摘要，最新快照仍更新，stop后的重启也能修订旧确认内容', async () => {
 const held = gate<void>(); const f = fixture(); const real = f.api.retain; let started = false;
 f.api.retain = async (bank, item) => { await real(bank, item); if (!started) { started = true; await held.promise; } };
 const first = f.memory.sync(contact, names, f.history.load(contact.qq)); let second: Promise<void> | undefined;
 try {
  await until(() => started); f.history.recall(contact.qq, 16); second = f.memory.sync(contact, names, f.history.load(contact.qq)); const drain = f.memory.stop(); held.release(); await drain; await Promise.all([first, second]);
  assert.equal(f.writes.length, 1); const old = JSON.parse(readFileSync(f.path, 'utf8')); assert.ok(Object.values(old.retainedDigests ?? {}).every(value => typeof value === 'string')); assert.equal(Object.keys(old.retainedDigests ?? {}).length, 1);
  const restart = new LongTermMemory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
  await restart.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.writes.length, 3); assert.ok([...f.documents.values()].every(item => !item.content.includes(marker)));
 } finally { held.release(); await Promise.allSettled([first, second]); await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('已公开安全片段新增危机即删除自己的稳定公共文档，不将危机正文重传公共库', async () => {
 const f = fixture(); const removed: string[] = [];
 f.api.deleteDocument = async (bank, id) => { removed.push(`${bank}/${id}`); f.documents.delete(`${bank}/${id}`); };
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq));
  f.history.append(contact.qq, { role: 'user', content: '我想自杀', time: new Date(now - 14 * 60_000).toISOString(), messageId: 31 });
  await f.memory.sync(contact, names, f.history.load(contact.qq)); await f.memory.sync(contact, names, f.history.load(contact.qq));
  assert.equal(removed.length, 1); assert.ok(removed[0]!.startsWith(f.memory.commonBankId())); assert.equal(f.writes.length, 2);
  assert.equal(f.documents.size, 1); const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(Object.keys(state.commonSkipped).length, 1); assert.deepEqual(state.commonDigests, {});
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('旧公共进度删除失败或缺能力不伪标skip，恢复后重试删除，404作为已不存在幂等确认', async () => {
 const f = fixture();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); f.history.append(contact.qq, { role: 'user', content: '我想自杀', time: new Date(now - 14 * 60_000).toISOString(), messageId: 31 });
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).commonSkipped, undefined);
  f.api.deleteDocument = async () => { throw new Error('synthetic unavailable'); };
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).commonSkipped, undefined);
  let deletes = 0; f.api.deleteDocument = async () => { deletes++; throw Object.assign(new Error('not found'), { status: 404 }); };
  await f.memory.sync(contact, names, f.history.load(contact.qq)); await f.memory.sync(contact, names, f.history.load(contact.qq));
  assert.equal(deletes, 1); assert.equal(Object.keys(JSON.parse(readFileSync(f.path, 'utf8')).commonSkipped).length, 1); assert.equal(f.writes.length, 2);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('明确从未公开的危机skip片段正常增长无需删除能力，也不会上传公共正文', async () => {
 const f = fixture();
 try {
  const input = f.history.load(contact.qq); input[0]!.content = '我想自杀';
  await f.memory.sync(contact, names, input); assert.equal(f.writes.length, 1);
  input.push({ role: 'user', content: '合成新句', time: new Date(now - 14 * 60_000).toISOString(), messageId: 31 });
  await f.memory.sync(contact, names, input); assert.equal(f.writes.length, 1);
  const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(Object.values(state.common)[0], 31); assert.equal(Object.keys(state.commonSkipped).length, 1);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

function advanced() {
 const operations = new Map<string, RetentionStatus>(), submissions: { id: string; bank: string; item: MemoryItem }[] = [];
 const f = fixture({ submitRetain: async (bank, item, id) => { submissions.push({ id, bank, item: structuredClone(item) }); operations.set(id, 'pending'); },
  retentionStatus: async (_bank, id) => operations.get(id) ?? 'not_found' });
 return { ...f, operations, submissions };
}

test('异步旧operation未完成不派新版本，completed只记实际旧摘要后才提交新UUID', async () => {
 const f = advanced();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1);
  f.history.recall(contact.qq, 16); await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1);
  const pending = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(Object.keys(pending.retained).length, 0);
  f.operations.set(f.submissions[0]!.id, 'completed'); await f.memory.sync(contact, names, f.history.load(contact.qq));
  assert.equal(f.submissions.length, 2); assert.notEqual(f.submissions[1]!.id, f.submissions[0]!.id); assert.ok(f.submissions[0]!.item.content.includes(marker)); assert.ok(!f.submissions[1]!.item.content.includes(marker));
  const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(Object.keys(state.retainedDigests).length, 1); assert.notEqual(Object.values(state.retainedDigests)[0], Object.values(state.pendingOwn as Record<string, { digest: string }>)[0]!.digest);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('派发超时重启保留intent，not_found且来源已撤回时不重发旧正文或猜已完成', async () => {
 const f = advanced(); const submit = f.api.submitRetain!;
 f.api.submitRetain = async (...args) => { await submit(...args); throw new Error('synthetic timeout'); };
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); const before = readFileSync(f.path, 'utf8'); assert.equal(f.submissions.length, 1);
  f.operations.clear(); f.history.recall(contact.qq, 16);
  const restarted = new LongTermMemory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
  await restarted.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1); assert.equal(readFileSync(f.path, 'utf8'), before);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('同payload未知结果只复用原UUID和不可变request，failed/cancelled保留屏障', async () => {
 const f = advanced();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); f.operations.clear();
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 2); assert.deepEqual(f.submissions[1], f.submissions[0]);
  for (const status of ['failed', 'cancelled'] as const) { f.operations.set(f.submissions[0]!.id, status); const before = readFileSync(f.path, 'utf8'); await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 2); assert.equal(readFileSync(f.path, 'utf8'), before); }
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('异步intent原文或归属被改会失败关闭，坏文件保原，不隔离重建丢UUID', async () => {
 const f = advanced();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); const state = JSON.parse(readFileSync(f.path, 'utf8'));
  Object.values(state.pendingOwn as Record<string, { item: { content: string } }>)[0]!.item.content = 'tampered synthetic';
  const before = JSON.stringify(state); writeFileSync(f.path, before);
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1); assert.equal(readFileSync(f.path, 'utf8'), before);
  writeFileSync(f.path, '{"SYNTHETIC_PRIVATE_BROKEN":'); await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1); assert.equal(readFileSync(f.path, 'utf8'), '{"SYNTHETIC_PRIVATE_BROKEN":');
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('intent持久化失败不派发，停止期间submit ACK只留pending不再发status', async () => {
 const f = advanced(); const write = fileOps.writeFileSync;
 try {
  fileOps.writeFileSync = ((...args: Parameters<typeof write>) => { if (String(args[1]).includes('"pendingOwn"')) throw new Error('synthetic write failure'); return write(...args); }) as typeof write;
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 0); fileOps.writeFileSync = write;
  const held = gate<void>(); const submit = f.api.submitRetain!; let statusCalls = 0;
  f.api.submitRetain = async (...args) => { await submit(...args); await held.promise; }; f.api.retentionStatus = async () => { statusCalls++; return 'completed'; };
  const task = f.memory.sync(contact, names, f.history.load(contact.qq)); await until(() => f.submissions.length === 1);
  const drain = f.memory.stop(); held.release(); await drain; await task;
  assert.equal(statusCalls, 0); const state = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(Object.keys(state.pendingOwn).length, 1); assert.equal(Object.keys(state.retained).length, 0);
 } finally { fileOps.writeFileSync = write; await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('旧公共pending完成前不删除或重发敏感片段，完成后仅删除原联系人文档', async () => {
 const f = advanced(); const removed: string[] = []; f.api.deleteDocument = async (bank, id) => { removed.push(`${bank}/${id}`); };
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); f.operations.set(f.submissions[0]!.id, 'completed');
  await f.memory.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 2); assert.ok(f.submissions[1]!.bank.endsWith('-common'));
  const input = f.history.load(contact.qq); input.push({ role: 'user', content: '我想自杀', time: new Date(now - 14 * 60_000).toISOString(), messageId: 31 });
  await f.memory.sync(contact, names, input); assert.equal(removed.length, 0); assert.equal(f.submissions.length, 2);
  f.operations.set(f.submissions[1]!.id, 'not_found'); await f.memory.sync(contact, names, input); assert.equal(removed.length, 0); assert.equal(f.submissions.length, 2);
  f.operations.set(f.submissions[1]!.id, 'completed'); await f.memory.sync(contact, names, input);
  assert.deepEqual(removed, [`${f.submissions[1]!.bank}/${f.submissions[1]!.item.document_id}`]); assert.equal(f.submissions.length, 2);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('更换bank前缀不能丢弃未确认intent或用新文件覆盖旧UUID', async () => {
 const f = advanced();
 try {
  await f.memory.sync(contact, names, f.history.load(contact.qq)); const before = readFileSync(f.path, 'utf8');
  const changed = new LongTermMemory({ api: f.api, dir: f.dir, common: true, bankPrefix: 'new-synthetic', recallTimeoutMs: 100, now: () => now, log() {} });
  await changed.sync(contact, names, f.history.load(contact.qq)); assert.equal(f.submissions.length, 1); assert.equal(readFileSync(f.path, 'utf8'), before);
 } finally { await f.memory.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});
