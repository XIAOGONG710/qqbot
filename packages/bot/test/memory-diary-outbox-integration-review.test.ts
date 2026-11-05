import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { diaryWriter } from '../src/life/diary.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { DerivedState } from '../src/memory/derived-state.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { HindsightApi, MemoryItem, RetentionStatus } from '../src/memory/hindsight.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { randomUUID } from 'node:crypto';

const schedule: Schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: 'one' }, periods: {}, semester: { start: '2026-09-01', weeks: 52 },
 holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
const now = new Date(2026, 10, 5, 12), first = new Date(2026, 10, 2, 12), firstDate = formatDate(first);
const contact = { qq: 10001, tier: 'classmate' as const, name: '合成联系人' };
const body = 'SYNTHETIC_PREPARED_DIARY_ORIGINAL_BODY';
function cleanup(dir: string) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-diary-outbox-integration-')); rmSync(dir, { recursive: true, force: true }); }
function fixture() {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-diary-outbox-integration-'));
 const submitted: { bank: string; item: MemoryItem; operationId: string }[] = [], legacy: MemoryItem[] = [], status = new Map<string, RetentionStatus>();
 const history: StoredMessage[] = [{ time: first.toISOString(), role: 'user', content: 'SYNTHETIC_DIARY_SOURCE', messageId: 1 }];
 const api: HindsightApi = { putBank: async () => {}, retain: async (_bank, item) => { legacy.push(structuredClone(item)); },
  submitRetain: async (bank, item, operationId) => { submitted.push({ bank, item: structuredClone(item), operationId }); status.set(operationId, 'pending'); },
  retentionStatus: async (_bank, operationId) => status.get(operationId) ?? 'not_found', recall: async () => [], getMentalModel: async () => undefined,
  createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => '' };
 const makeMemory = () => new LongTermMemory({ dir, api, common: true, bankPrefix: 'synthetic', recallTimeoutMs: 100, now: () => now.getTime(), log() {} });
 let generatedFirst = 0, since: string | undefined = new Date(first.getTime() - 60_000).toISOString(), sourceReader = true;
 let generateWait: (() => Promise<void>) | undefined;
 let customGenerate: Parameters<typeof diaryWriter>[0]['generate'] | undefined;
 let selectedSchedule = schedule;
 const makeWriter = (memory: LongTermMemory) => diaryWriter({ dir, memory, sources: { charName: '合成角色', schedule: selectedSchedule, moods: [], books: [] }, contacts: [contact],
  ...(sourceReader ? { sourceSince: () => since } : {}),
  history: { load: () => structuredClone(history) }, generate: async messages => {
   if (customGenerate) return customGenerate(messages);
   if (String(messages[0]!.content).includes(`${first.getMonth() + 1}月${first.getDate()}日`)) { generatedFirst++; await generateWait?.(); return generatedFirst === 1 ? body : 'SYNTHETIC_REGENERATED_DIFFERENT_BODY'; }
   return '';
  }, log() {} });
 const state = () => existsSync(join(dir, 'diary.json')) ? JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8')) : {};
 return { dir, api, history, submitted, legacy, status, makeMemory, makeWriter, state, generated: () => generatedFirst,
  since: (value: string | undefined) => { since = value; }, sourceReader: (enabled: boolean) => { sourceReader = enabled; }, waitGenerate: (work: () => Promise<void>) => { generateWait = work; },
  generate: (work: Parameters<typeof diaryWriter>[0]['generate']) => { customGenerate = work; }, schedule: (value: Schedule) => { selectedSchedule = value; } };
}

test('真实Writer+LongTerm：accepted不是written，stop/restart只查询同body/UUID直到completed', async () => {
 const f = fixture(); let memory = f.makeMemory(), writer = f.makeWriter(memory);
 try { await writer.catchUp(now); assert.equal(f.legacy.length, 0, 'advanced日记必须走持久提交协议'); assert.equal(f.submitted.length, 1);
  assert.equal(f.state().written?.[firstDate], undefined); const original = structuredClone(f.submitted[0]!);
  await writer.stop(); await memory.stop(); memory = f.makeMemory(); writer = f.makeWriter(memory);
  await writer.catchUp(now); assert.equal(f.submitted.length, 1); assert.equal(f.generated(), 1); assert.equal(f.state().written?.[firstDate], undefined);
  f.status.set(original.operationId, 'completed'); await writer.catchUp(now);
  assert.equal(f.generated(), 1); assert.equal(f.state().texts[firstDate], body); assert.ok(f.state().written[firstDate] > 0);
  assert.deepEqual(f.submitted[0], original); assert.equal(f.submitted.length, 1);
 } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('准备来源清单明确区分known tier since与unknown，不凭当前时间补造旧证据', async () => {
 for (const mode of ['known-boundary', 'known-unbounded', 'unknown'] as const) {
  const known = mode !== 'unknown', f = fixture(), memory = f.makeMemory(); if (mode !== 'known-boundary') f.since(undefined); if (!known) f.sourceReader(false); const writer = f.makeWriter(memory);
  try { await writer.catchUp(now); assert.equal(f.submitted.length, 1);
   const prepared = Object.values(f.state().prepared) as { manifest: { contributors: { qq: number; sinceKnown: boolean; since?: string }[] } }[];
   const owner = prepared[0]!.manifest.contributors.find(item => item.qq === contact.qq)!;
   assert.equal(owner.sinceKnown, known); assert.equal(owner.since !== undefined, mode === 'known-boundary');
  } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
 }
});

test('生成await期间档位since变化，旧来源正文不能派发或发布prepared/written', async () => {
 const f = fixture(), memory = f.makeMemory(), writer = f.makeWriter(memory); let entered = false, release!: () => void;
 const held = new Promise<void>(done => { release = done; }); f.waitGenerate(async () => { entered = true; await held; });
 try { const job = writer.catchUp(now); const deadline = Date.now() + 2000;
  while (!entered) { assert.ok(Date.now() < deadline, 'synthetic generation timeout'); await new Promise(done => setImmediate(done)); }
  f.since(new Date(first.getTime() + 60_000).toISOString()); release(); await job;
  assert.equal(f.submitted.length, 0); assert.equal(f.state().written?.[firstDate], undefined);
  assert.equal(f.state().prepared?.[`diary:${firstDate}`], undefined);
 } finally { release(); await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('旧written/texts合法兼容但不凭空升级为confirmed来源收据', async () => {
 const f = fixture(), memory = f.makeMemory();
 writeFileSync(join(f.dir, 'diary.json'), JSON.stringify({ written: { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1 }, texts: { [firstDate]: 'SYNTHETIC_LEGACY_DIARY' },
  weeks: { '2026-10-19': 1, '2026-10-26': 1 }, phases: {} })); const writer = f.makeWriter(memory);
 try { await writer.catchUp(now); assert.equal(f.submitted.length, 0); assert.equal(f.generated(), 0);
  assert.equal(f.state().confirmed?.[`diary:${firstDate}`], undefined); assert.equal(f.state().texts[firstDate], 'SYNTHETIC_LEGACY_DIARY');
 } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('submit已派held时双层stop等待accepted ACK，重启只核同UUID完成后发布writer记录', async () => {
 const f = fixture(); let memory = f.makeMemory(), writer = f.makeWriter(memory), entered = false, release!: () => void;
 const held = new Promise<void>(done => { release = done; });
 f.api.submitRetain = async (bank, item, operationId) => { f.submitted.push({ bank, item: structuredClone(item), operationId }); entered = true; await held; f.status.set(operationId, 'completed'); };
 let job: Promise<void> | undefined;
 try { job = writer.catchUp(now); const deadline = Date.now() + 2000;
  while (!entered) { assert.ok(Date.now() < deadline, 'synthetic submission timeout'); await new Promise(done => setImmediate(done)); }
  const writerDrain = writer.stop(), memoryDrain = memory.stop(); assert.ok(writerDrain instanceof Promise); assert.ok(memoryDrain instanceof Promise);
  let stopped = false; void Promise.all([writerDrain, memoryDrain]).then(() => { stopped = true; }); await new Promise(done => setImmediate(done)); assert.equal(stopped, false);
  release(); await writerDrain; await memoryDrain; await job; assert.equal(f.state().written?.[firstDate], undefined);
  memory = f.makeMemory(); writer = f.makeWriter(memory); await writer.catchUp(now);
  assert.equal(f.submitted.length, 1); assert.equal(f.generated(), 1); assert.equal(f.state().texts[firstDate], body);
 } finally { release(); await job?.catch(() => {}); await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('已派日记源撤回后只核对旧UUID，completed记录实际正文但sharedguard继续保护', async () => {
 const f = fixture(); let memory = f.makeMemory(), writer = f.makeWriter(memory);
 try { await writer.catchUp(now); assert.equal(f.submitted.length, 1); const operation = f.submitted[0]!.operationId;
  await writer.stop(); await memory.stop(); f.history[0] = { ...f.history[0]!, content: '[撤回了一条消息]', recalled: true };
  memory = f.makeMemory(); memory.noteRecall(contact, structuredClone(f.history)); writer = f.makeWriter(memory); f.status.set(operation, 'completed');
  await writer.catchUp(now); assert.equal(f.submitted.length, 1); assert.equal(f.generated(), 1);
  assert.equal(f.state().texts[firstDate], body); assert.ok(f.state().written[firstDate] > 0);
  assert.equal(new DerivedState(f.dir).snapshot(memory.commonBankId()).dirty, true); assert.equal(memory.derivedAvailable(), false);
 } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('completed后writer完成记录的rename前后失败不重生正文，不重复submit', async () => {
 for (const afterPublish of [false, true]) {
  const f = fixture(), memory = f.makeMemory(), writer = f.makeWriter(memory), rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
  f.api.submitRetain = async (bank, item, operationId) => { f.submitted.push({ bank, item: structuredClone(item), operationId }); f.status.set(operationId, 'completed'); };
  let injected = false;
  try { fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
    if (to === join(f.dir, 'diary.json') && JSON.parse(readFileSync(from, 'utf8')).written?.[firstDate] > 0) {
     injected = true; if (afterPublish) rename(from, to); throw Error('synthetic writer completion publish failure');
    }
    rename(from, to);
   };
   if (afterPublish) await writer.catchUp(now); else await assert.rejects(writer.catchUp(now));
   assert.equal(injected, true); fileOps.renameSync = rename; await writer.catchUp(now);
   assert.equal(f.generated(), 1); assert.equal(f.submitted.length, 1); assert.equal(f.state().texts[firstDate], body);
  } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; await writer.stop(); await memory.stop(); cleanup(f.dir); }
 }
});

test('初始坏prepared状态或未知新版不能当legacy重建，原件与私密正文均保留且安全报错', async () => {
 for (const data of [{ written: [], texts: { [firstDate]: 'SYNTHETIC_PRIVATE_BAD_STATE' } },
  { version: 999, written: {}, texts: {}, weeks: {}, phases: {}, prepared: {}, confirmed: {} }]) {
  const f = fixture(), memory = f.makeMemory(), writer = f.makeWriter(memory), path = join(f.dir, 'diary.json'), raw = JSON.stringify(data);
  writeFileSync(path, raw);
  try { await assert.rejects(writer.catchUp(now), error => !String(error).includes('SYNTHETIC_PRIVATE_BAD_STATE'));
   assert.equal(readFileSync(path, 'utf8'), raw); assert.equal(f.generated(), 0); assert.equal(f.submitted.length, 0); assert.equal(f.legacy.length, 0);
  } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
 }
});

test('旧completed不能确认不同正文/角色/日时参数，同body核对允许且公共blocker跨重启单调', async () => {
 const f = fixture(); let memory = f.makeMemory(); const operationId = randomUUID();
 try { assert.equal(await memory.retainDiary(firstDate, first, body, '合成角色', { operationId }), false); assert.equal(f.submitted.length, 1);
  f.status.set(operationId, 'completed');
  assert.equal(await memory.retainDiary(firstDate, first, 'SYNTHETIC_WRONG_BODY', '合成角色', { operationId, allowSubmit: false }), false);
  assert.equal(await memory.retainDiary(firstDate, first, body, '合成别的角色', { operationId, allowSubmit: false }), false);
  assert.equal(await memory.retainDiary(firstDate, new Date(first.getTime() + 86_400_000), body, '合成角色', { operationId, allowSubmit: false }), false);
  memory.noteWrittenSourceChanged(`diary:${firstDate}`);
  assert.equal(await memory.retainDiary(firstDate, first, body, '合成角色', { operationId, allowSubmit: false }), true);
  assert.equal(memory.derivedAvailable(), false); await memory.stop(); memory = f.makeMemory();
  assert.equal(memory.derivedAvailable(), false); assert.equal(await memory.retainDiary('2026-11-03', new Date(2026, 10, 3), 'SYNTHETIC_NEW_BODY', '合成角色'), false);
  assert.equal(f.submitted.length, 1); assert.equal(f.legacy.length, 0);
 } finally { await memory.stop(); cleanup(f.dir); }
});

test('周记绑定旧日记真实bodyHash并标legacy；依赖变后只结旧UUID且来源未验证不开放公共', async () => {
 const f = fixture(), memory = f.makeMemory(); let generations = 0;
 const diaryDate = '2026-10-20', summaryId = 'week:2026-10-19', legacyBody = 'SYNTHETIC_LEGACY_SUMMARY_DEPENDENCY';
 writeFileSync(join(f.dir, 'diary.json'), JSON.stringify({ written: { '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1, [diaryDate]: 1 },
  texts: { [diaryDate]: legacyBody }, weeks: {}, phases: {} }));
 f.generate(async () => { generations++; return 'SYNTHETIC_PREPARED_SUMMARY_BODY'; }); const writer = f.makeWriter(memory);
 try { await writer.catchUp(now); assert.equal(f.submitted.length, 1); assert.equal(f.submitted[0]!.item.document_id, summaryId);
  const pending = f.state().prepared[summaryId], dependency = pending.manifest.dependencies[0];
  assert.equal(dependency.documentId, `diary:${diaryDate}`); assert.equal(dependency.legacy, true); assert.equal(dependency.sourceHash, undefined); assert.match(dependency.bodyHash, /^[a-f0-9]{64}$/);
  const state = f.state(); state.texts[diaryDate] = 'SYNTHETIC_CHANGED_LEGACY_DEPENDENCY'; writeFileSync(join(f.dir, 'diary.json'), JSON.stringify(state));
  f.status.set(f.submitted[0]!.operationId, 'completed'); await writer.catchUp(now);
  const confirmed = f.state().confirmed[summaryId]; assert.equal(confirmed.sourceVerified, false); assert.deepEqual(confirmed.manifest.dependencies[0], dependency);
  assert.equal(f.submitted.length, 1); assert.equal(generations, 1); assert.equal(memory.derivedAvailable(), false);
 } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('已确认日记在后续summary前重新核对since/来源，变化持久阻断且保留真实written', async () => {
 const f = fixture(), memory = f.makeMemory();
 f.schedule({ ...structuredClone(schedule), holidays: [{ name: '合成小假期', start: firstDate, end: firstDate }] });
 f.api.submitRetain = async (bank, item, operationId) => { f.submitted.push({ bank, item: structuredClone(item), operationId }); f.status.set(operationId, 'completed'); };
 const writer = f.makeWriter(memory); let summaryGenerations = 0;
 try { await writer.catchUp(now); assert.equal(f.state().texts[firstDate], body); assert.equal(f.state().confirmed[`diary:${firstDate}`].sourceVerified, true);
  const state = f.state(); state.written['2026-11-03'] = 1; state.written['2026-11-04'] = 1; state.weeks['2026-10-19'] = 0; state.weeks['2026-10-26'] = 0;
  writeFileSync(join(f.dir, 'diary.json'), JSON.stringify(state)); f.since(new Date(first.getTime() + 60_000).toISOString());
  f.generate(async () => { summaryGenerations++; return 'SYNTHETIC_STALE_SUMMARY_MUST_NOT_LEAVE'; }); await writer.catchUp(now);
  assert.equal(summaryGenerations, 0); assert.equal(f.submitted.length, 1); assert.equal(f.state().texts[firstDate], body); assert.ok(f.state().written[firstDate] > 0);
  assert.equal(memory.derivedAvailable(), false);
 } finally { await writer.stop(); await memory.stop(); cleanup(f.dir); }
});

test('prepared已验来源后LongTerm建库await期间since变化，真正submit前必须fresh拒绝旧正文', async () => {
 const f = fixture(), memory = f.makeMemory(), writer = f.makeWriter(memory); let entered = false, release!: () => void;
 const held = new Promise<void>(done => { release = done; }); f.api.putBank = async () => { entered = true; await held; };
 let job: Promise<void> | undefined;
 try { job = writer.catchUp(now); const deadline = Date.now() + 2000;
  while (!entered) { assert.ok(Date.now() < deadline, 'synthetic common-bank timeout'); await new Promise(done => setImmediate(done)); }
  assert.equal(f.generated(), 1); assert.equal(f.submitted.length, 0); assert.ok(f.state().prepared[`diary:${firstDate}`]);
  // Do not call noteRecall: the caller's source capability itself changed during an internal await.
  f.since(new Date(first.getTime() + 60_000).toISOString()); release(); await job;
  assert.equal(f.submitted.length, 0, 'LongTerm不能把await前捕获的allowSubmit:true当作派发时仍有效');
  assert.equal(f.state().written?.[firstDate], undefined);
 } finally { release(); await job?.catch(() => {}); await writer.stop(); await memory.stop(); cleanup(f.dir); }
});
