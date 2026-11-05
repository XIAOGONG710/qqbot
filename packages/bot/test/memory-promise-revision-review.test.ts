import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promiseKeeper, type PromiseKeeperOptions } from '../src/life/promises.ts';
import { emptyPromiseState, readPromiseState } from '../src/life/promise-state.ts';
import { ChatHistory } from '../src/memory/history.ts';
function cleanup(root: string) { const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('qqbot-promise-revision-')); rmSync(target, { recursive: true, force: true }); }
const contact = { qq: 10001, tier: 'boyfriend' as const, name: 'Synthetic User' };
const at = (time: string) => new Date(`2026-11-05T${time}:00`);
const answer = JSON.stringify({ add: [{ what: 'SYNTHETIC_MEETING', date: '2026-11-05', meet: { time: '18:00', where: '东门' } }], resolved: [] });
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, '合成等待超时'); await new Promise(resolve => setImmediate(resolve)); } }
function fixture(closed = false, content = '好，今晚18点东门见') {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-promise-revision-')), history = new ChatHistory(root), dir = join(root, 'promises');
 mkdirSync(dir, { recursive: true });
 history.append(contact.qq, { role: 'assistant', time: at('17:30').toISOString(), content: '今晚18点一起去东门吃饭吗？', messageId: 1 });
 history.append(contact.qq, { role: 'user', time: at('17:31').toISOString(), content, messageId: 2 });
 let clock = at(closed ? '18:30' : '17:35').getTime();
 const options: Omit<PromiseKeeperOptions, 'extract'> = { contacts: [contact], history, names: () => ({ char: 'Synthetic Character', user: contact.name }), dir, now: () => clock, log() {} };
 return { root, dir, path: join(dir, '10001-boyfriend.json'), history, options, clock: (date: Date) => { clock = date.getTime(); } };
}

for (const closed of [false, true]) test(`extract等待期间来源撤回整结果丢弃，不标计数/不resolved/不回写世界 closed=${closed}`, async () => {
 const f = fixture(closed), held = gate<string>(); let begun = false, worlds = 0;
 const keeper = promiseKeeper({ ...f.options, onWorldActions: () => { worlds++; }, extract: async () => { begun = true; return held.promise; } });
 const seeded = emptyPromiseState(); seeded.promises.push({ id: 'old', what: 'VALID_OLD_PROMISE', date: '2026-11-05', said: '2026-11-04', episode: 'ep-1' }); writeFileSync(f.path, JSON.stringify(seeded));
 const task = keeper.sync();
 try { await until(() => begun); assert.equal(f.history.recall(contact.qq, 2), true);
  held.release(JSON.stringify({ add: [{ what: 'SYNTHETIC_MEETING', date: '2026-11-05', meet: { time: '18:00' } }], resolved: ['old'], world: [{ kind: 'feed_cat', at: '2026-11-05T17:31' }] })); await task;
  const state = readPromiseState(f.path); assert.deepEqual(state.promises, seeded.promises); assert.deepEqual(state.early, {}); assert.deepEqual(state.extracted, {}); assert.equal(worlds, 0);
 } finally { held.release('{}'); await task; await keeper.stop(); cleanup(f.root); }
});

test('已有early同count撤回立即从全部读口隐藏，重启同样，随后重抽建立新来源', async () => {
 const f = fixture(); let calls = 0;
 const opts = { ...f.options, extract: async () => { calls++; return calls === 1 ? answer : '{"add":[],"resolved":[]}'; } };
 const keeper = promiseKeeper(opts);
 try { await keeper.sync(); assert.equal(keeper.appointmentsAt(at('18:10')).length, 1); f.history.recall(contact.qq, 2);
  assert.equal(keeper.appointmentsAt(at('18:10')).length, 0); assert.deepEqual(keeper.plansOn('2026-11-05'), []); assert.equal(keeper.describe(contact, [], at('17:35')), undefined);
  const restarted = promiseKeeper(opts); assert.equal(restarted.appointmentsBetween(at('17:30'), at('20:00')).length, 0); await restarted.sync(); assert.equal(calls, 2); assert.equal(restarted.appointmentsAt(at('18:10')).length, 0);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('旧无摘要early仅有可信遮盖证据时暂避，不猜取消全部旧约，也不把字面占位当撤回', async () => {
 const f = fixture(); const keeper = promiseKeeper({ ...f.options, extract: async () => answer });
 try { await keeper.sync(); const state = JSON.parse(readFileSync(f.path, 'utf8')); delete state.sources; delete state.attemptSources; delete state.promiseVersions; writeFileSync(f.path, JSON.stringify(state));
  assert.equal(promiseKeeper({ ...f.options, extract: async () => answer }).appointmentsAt(at('18:10')).length, 1);
  f.history.recall(contact.qq, 2); assert.equal(promiseKeeper({ ...f.options, extract: async () => answer }).appointmentsAt(at('18:10')).length, 0);
  assert.equal(promiseKeeper({ ...f.options, extract: async () => answer }).available(), false);
 } finally { await keeper.stop(); cleanup(f.root); }
});

for (const closed of [false, true]) for (const cancel of [false, true]) test(`变更源撤回只撤本次effects，恢复此前已确认约并跨重启 closed=${closed} cancel=${cancel}`, async () => {
 const f = fixture(closed), old = { id: 'old-confirmed', what: 'VALID_OLD_MEET', date: '2026-11-05', said: '2026-11-04', episode: 'ep-1', meet: { time: '19:00', minutes: 90, where: '东门' } };
 const initial = emptyPromiseState(); initial.promises.push(old); writeFileSync(f.path, JSON.stringify(initial)); let calls = 0;
 const opts = { ...f.options, extract: async () => { calls++; return calls === 1 ? JSON.stringify(cancel ? { add: [], resolved: [old.id] }
  : { add: [{ what: 'UPDATED_MEET', date: '2026-11-05', meet: { time: '19:00', where: '西门' } }], resolved: [] }) : '{"add":[],"resolved":[]}'; } };
 const keeper = promiseKeeper(opts);
 try {
  await keeper.sync(); const active = keeper.appointmentsAt(at('19:10')); assert.equal(active.length, cancel ? 0 : 1); if (!cancel) assert.equal(active[0]!.promise.meet!.where, '西门');
  assert.equal(f.history.recall(contact.qq, 2), true);
  const restored = keeper.appointmentsAt(at('19:10')); assert.equal(restored.length, 1); assert.deepEqual(restored[0]!.promise, old);
  const restart = promiseKeeper(opts); assert.deepEqual(restart.appointmentsAt(at('19:10'))[0]!.promise, old); await restart.sync(); assert.equal(calls, 2);
  assert.deepEqual(restart.appointmentsAt(at('19:10'))[0]!.promise, old);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('闭段新增和loop resolved也有来源before/after，撤回后不必等sync即可恢复', async () => {
 const f = fixture(true), initial = emptyPromiseState();
 initial.loops.push({ id: 'a-old', kind: 'waiting', what: 'VALID_OLD_LOOP', said: '2026-11-05', date: '2026-11-05', episode: 'ep-1' }); writeFileSync(f.path, JSON.stringify(initial));
 const keeper = promiseKeeper({ ...f.options, extract: async () => JSON.stringify({ add: [{ what: 'NEW_PROMISE', date: '2026-11-05' }], waiting: [{ what: 'NEW_LOOP', date: '2026-11-05' }], resolved: ['a-old'] }) });
 try {
  await keeper.sync(); assert.deepEqual(keeper.plansOn('2026-11-05'), ['NEW_PROMISE']); assert.equal(f.history.recall(contact.qq, 2), true);
  assert.deepEqual(keeper.plansOn('2026-11-05'), []); const loops = keeper.openLoops(contact, [], at('21:00'));
  assert.ok(JSON.stringify(loops).includes('VALID_OLD_LOOP')); assert.ok(!JSON.stringify(loops).includes('NEW_LOOP'));
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('等待期间另一来源被撤回，即使当前episode不变也丢弃带旧pending上下文的结果', async () => {
 const f = fixture(true); let mode: 'initial' | 'held' = 'initial', begun = false; const held = gate<string>();
 const keeper = promiseKeeper({ ...f.options, extract: async () => { if (mode === 'initial') return '{"add":[{"what":"OLD_SOURCE_PROMISE","date":"2026-11-05"}],"resolved":[]}'; begun = true; return held.promise; } });
 try {
  await keeper.sync(); const original = readPromiseState(f.path).promises[0]!;
  const frozen = f.history.load(contact.qq); const altered = structuredClone(frozen); altered[1] = { ...altered[1]!, content: '[撤回了一条消息]', recalled: true };
  const newEpisode = [{ role: 'assistant' as const, content: '我们再讨论另件事', time: at('19:00').toISOString(), messageId: 3 }, { role: 'user' as const, content: '好的', time: at('19:01').toISOString(), messageId: 4 }];
  let withdrawn = false; mode = 'held';
  const other = promiseKeeper({ ...f.options, now: () => at('20:00').getTime(), history: { load: () => [...(withdrawn ? altered : frozen), ...newEpisode] }, extract: async () => { begun = true; return held.promise; } });
  const task = other.sync(); await until(() => begun); withdrawn = true; held.release(JSON.stringify({ add: [{ what: 'STALE_CONTEXT_RESULT', date: '2026-11-05' }], resolved: [original.id] })); await task;
  const saved = readPromiseState(f.path); assert.ok(!saved.promises.some(item => item.what === 'STALE_CONTEXT_RESULT')); assert.deepEqual(Object.keys(saved.extracted).length, 1);
 } finally { held.release('{}'); await keeper.stop(); cleanup(f.root); }
});

test('来源和world回调拿到独立快照，别名修改不篡改提取前digest/count', async () => {
 const f = fixture(true), stable = f.history.load(contact.qq), firstView = structuredClone(stable); let loads = 0, callbackContent = '';
 const keeper = promiseKeeper({ ...f.options, history: { load: () => ++loads === 1 ? firstView : structuredClone(stable) }, extract: async () => { firstView[1]!.content = 'MUTATED_ALIAS'; return answer; },
  onWorldActions: (_contact, episode) => { callbackContent = episode.messages[1]!.content; episode.messages[1]!.content = 'MUTATED_CALLBACK'; } });
 try { await keeper.sync(); assert.equal(callbackContent, stable[1]!.content); assert.equal(keeper.appointmentsAt(at('18:10')).length, 1); assert.equal(readPromiseState(f.path).sources![Object.keys(readPromiseState(f.path).sources!)[0]!]!.count, 2); }
 finally { await keeper.stop(); cleanup(f.root); }
});

test('等待旧闭段提取时另一无关user-only新片段不造成无关饥饿', async () => {
 const f = fixture(true), held = gate<string>(); let begun = false;
 const keeper = promiseKeeper({ ...f.options, extract: async () => { begun = true; return held.promise; } }); const task = keeper.sync();
 try { await until(() => begun); f.history.append(contact.qq, { role: 'user', content: '无关新问候', time: at('18:25').toISOString(), messageId: 10 }); held.release(answer); await task;
  assert.equal(keeper.appointmentsAt(at('18:10')).length, 1);
 } finally { held.release('{}'); await task; await keeper.stop(); cleanup(f.root); }
});

test('同open重复改地点保留最初confirmed before，撤回最新改动不把上次临时值当基线', async () => {
 const f = fixture(), initial = emptyPromiseState(); initial.promises.push({ id: 'confirmed', what: 'OLD_CONFIRMED', date: '2026-11-05', said: '2026-11-04', episode: 'ep-1', meet: { time: '19:00', minutes: 90, where: '东门' } }); writeFileSync(f.path, JSON.stringify(initial)); let calls = 0;
 const keeper = promiseKeeper({ ...f.options, extract: async () => { calls++; return JSON.stringify({ add: [{ what: 'CHANGED', date: '2026-11-05', meet: { time: '19:00', where: calls === 1 ? '西门' : '南门' } }], resolved: [] }); } });
 try { await keeper.sync(); f.history.append(contact.qq, { role: 'user', content: '改成19点南门见面', time: at('17:32').toISOString(), messageId: 3 }); await keeper.sync();
  assert.equal(keeper.appointmentsAt(at('19:10'))[0]!.promise.meet!.where, '南门'); f.history.recall(contact.qq, 3); assert.deepEqual(keeper.appointmentsAt(at('19:10'))[0]!.promise, initial.promises[0]);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('较晚有效来源接管同ID后不被较早source回滚，双源失效按causal版本链回原confirmed', async () => {
 const f = fixture(true), initial = emptyPromiseState(); initial.promises.push({ id: 'confirmed', what: 'OLD_CONFIRMED', date: '2026-11-05', said: '2026-11-04', episode: 'ep-1', meet: { time: '19:00', minutes: 90, where: '东门' } }); writeFileSync(f.path, JSON.stringify(initial));
 const view = f.history.load(contact.qq); let calls = 0, clock = at('18:30').getTime();
 const keeper = promiseKeeper({ ...f.options, history: { load: () => structuredClone(view) }, now: () => clock,
  extract: async () => { calls++; return JSON.stringify({ add: [{ what: 'CHANGED', date: '2026-11-05', meet: { time: '19:00', where: calls === 1 ? '西门' : '北门' } }], resolved: [] }); } });
 try {
  await keeper.sync(); view.push({ role: 'assistant', content: '另外一段重新确认安排', time: at('19:00').toISOString(), messageId: 3 }, { role: 'user', content: '好，今晚19点北门见面', time: at('19:01').toISOString(), messageId: 4 }); clock = at('20:00').getTime(); await keeper.sync();
  assert.equal(keeper.appointmentsAt(at('19:10'))[0]!.promise.meet!.where, '北门');
  // 直接修订合成来源视图验证版本链，不假称ADR0082允许撤回已经回复的消息。
  view[1]!.content = '旧来源内容已更正'; assert.equal(keeper.appointmentsAt(at('19:10'))[0]!.promise.meet!.where, '北门');
  view[3]!.content = '后来的来源内容也已更正'; assert.deepEqual(keeper.appointmentsAt(at('19:10'))[0]!.promise, initial.promises[0]);
  const restart = promiseKeeper({ ...f.options, history: { load: () => structuredClone(view) }, extract: async () => '{}' }); assert.deepEqual(restart.appointmentsAt(at('19:10'))[0]!.promise, initial.promises[0]);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('旧已取消的约没有before-image不能猜恢复，可信撤回进度持久为待人工确认', async () => {
 const f = fixture(true), state = emptyPromiseState(); const id = `ep-${at('17:30').getTime()}`; state.extracted[id] = true; writeFileSync(f.path, JSON.stringify(state)); f.history.recall(contact.qq, 2);
 let calls = 0; const keeper = promiseKeeper({ ...f.options, extract: async () => { calls++; return answer; } });
 try { assert.equal(keeper.available(), false); assert.throws(() => keeper.plansOn('2026-11-05')); await keeper.sync(); assert.equal(calls, 0); assert.equal(readPromiseState(f.path).uncertainSources?.[id], true);
  const restarted = promiseKeeper({ ...f.options, extract: async () => answer }); assert.equal(restarted.available(), false); assert.equal(readPromiseState(f.path).promises.length, 0);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('未来仍有效的early即使旧计数裁剪也保留来源和因果证据，不静默退回legacy', async () => {
 const f = fixture(), keeper = promiseKeeper({ ...f.options, extract: async () => '{"add":[{"what":"FUTURE_MEET","date":"2026-12-20","meet":{"time":"18:00"}}],"resolved":[]}' });
 try { await keeper.sync(); f.clock(new Date('2026-12-10T12:00:00')); await keeper.sync();
  assert.equal(keeper.appointmentsAt(new Date('2026-12-20T18:10:00')).length, 1); const state = readPromiseState(f.path); assert.equal(Object.keys(state.sources ?? {}).length, 1);
  assert.equal(f.history.recall(contact.qq, 2), true); assert.equal(keeper.appointmentsAt(new Date('2026-12-20T18:10:00')).length, 0);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('真实history文件缺失不能当成合法撤回，活source日历未知且恢复文件后原约仍可用', async () => {
 const f = fixture(), keeper = promiseKeeper({ ...f.options, extract: async () => answer });
 try {
  await keeper.sync(); assert.equal(keeper.appointmentsAt(at('18:10')).length, 1);
  const chatPath = join(f.root, 'chats', '10001.jsonl'), bytes = readFileSync(chatPath), state = readFileSync(f.path, 'utf8'); unlinkSync(chatPath);
  assert.equal(keeper.available(), false); assert.throws(() => keeper.appointmentsBetween(at('17:30'), at('20:00'))); assert.throws(() => keeper.plansOn('2026-11-05'));
  const restarted = promiseKeeper({ ...f.options, extract: async () => answer }); assert.equal(restarted.available(), false); await restarted.sync(); assert.equal(readFileSync(f.path, 'utf8'), state);
  writeFileSync(chatPath, bytes.toString('utf8').split('\n')[0]! + '\n'); assert.equal(keeper.available(), false, '片段只剩部分消息也不等于合法撤回');
  writeFileSync(chatPath, bytes); assert.equal(keeper.available(), true); assert.equal(keeper.appointmentsAt(at('18:10')).length, 1);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('缺失来源已无活效果且全部约过期时不永久阻塞日历', async () => {
 const f = fixture(), keeper = promiseKeeper({ ...f.options, extract: async () => answer });
 try { await keeper.sync(); f.clock(new Date('2026-11-10T12:00:00')); unlinkSync(join(f.root, 'chats', '10001.jsonl'));
  assert.equal(keeper.available(), true); assert.deepEqual(keeper.appointmentsBetween(new Date('2026-11-10T12:00:00'), new Date('2026-11-10T23:00:00')), []);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('正常追加及助手后来回复不误伤已提交prefix，危机keep保留', async () => {
 for (const crisis of [false, true]) {
  const f = fixture(false, crisis ? '好，今晚18点东门见。我想自杀' : undefined), keeper = promiseKeeper({ ...f.options, extract: async () => answer });
  try { await keeper.sync();
   if (crisis) assert.equal(f.history.recall(contact.qq, 2, () => true), false);
   else { f.history.append(contact.qq, { role: 'assistant', content: '好，已经约好了', time: at('17:36').toISOString(), messageId: 3 }); assert.equal(f.history.recall(contact.qq, 2), false); }
   assert.equal(keeper.appointmentsAt(at('18:10')).length, 1); assert.equal(promiseKeeper({ ...f.options, extract: async () => answer }).appointmentsAt(at('18:10')).length, 1);
  } finally { await keeper.stop(); cleanup(f.root); }
 }
});

test('history暂不可读是来源未知，不把早约当空日历或丢弃旧文件', async () => {
 const f = fixture(); let bad = false; const keeper = promiseKeeper({ ...f.options, history: { load: qq => { if (bad) throw new Error('SYNTHETIC_PRIVATE'); return f.history.load(qq); } }, extract: async () => answer });
 try { await keeper.sync(); const before = readFileSync(f.path, 'utf8'); bad = true; assert.equal(keeper.available(), false);
  assert.throws(() => keeper.appointmentsBetween(at('17:30'), at('20:00'))); assert.throws(() => keeper.plansOn('2026-11-05')); assert.equal(readFileSync(f.path, 'utf8'), before);
  bad = false; assert.equal(keeper.appointmentsAt(at('18:10')).length, 1);
 } finally { await keeper.stop(); cleanup(f.root); }
});

test('来源改变后迟到失败不消耗新source重试次数或early计数', async () => {
 const f = fixture(true), held = gate<string>(); let begun = false;
 const keeper = promiseKeeper({ ...f.options, extract: async () => { begun = true; return held.promise; } }); const task = keeper.sync();
 try { await until(() => begun); f.history.recall(contact.qq, 2); held.release('not valid JSON'); await task;
  const state = existsSync(f.path) ? readPromiseState(f.path) : emptyPromiseState(); assert.deepEqual(state.extracted, {}); assert.deepEqual(state.early, {});
 } finally { held.release('{}'); await task; await keeper.stop(); cleanup(f.root); }
});

test('合法旧记录的原型同名ID按字面记因果版本，取消及撤回恢复不误暂停', async () => {
 for (const id of ['constructor', '__proto__']) {
  const f = fixture();
  const original = { id, what: 'OLD_CONFIRMED', said: '2026-11-05', date: '2026-11-05', episode: 'ep-1', meet: { time: '19:00', minutes: 60, where: '东门' } };
  writeFileSync(join(f.dir, '10001-boyfriend.json'), JSON.stringify({ ...emptyPromiseState(), promises: [original] }));
  const keeper = promiseKeeper({ ...f.options, extract: async () => JSON.stringify({ add: [], resolved: [id] }) });
  try {
   await keeper.sync(); assert.equal(keeper.available(), true, '继承属性不是已有版本');
   assert.deepEqual(keeper.plansOn('2026-11-05'), []);
   assert.equal(f.history.recall(contact.qq, 2), true);
   assert.deepEqual(keeper.plansOn('2026-11-05'), ['OLD_CONFIRMED']);
   assert.equal(keeper.appointmentsAt(at('19:10'))[0]?.promise.id, id);
  } finally { await keeper.stop(); cleanup(f.root); }
 }
});
