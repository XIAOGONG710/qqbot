import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { acquireLock } from '../src/platform/lock.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { pokeBackPlan } from '../src/social/pokes.ts';

const turn = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await turn(); }
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-app-poke-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout, oldClearTimeout = globalThis.clearTimeout;
 const handles = new Set<ReturnType<typeof setTimeout>>(), cleared = new Set<ReturnType<typeof setTimeout>>(), logs: string[] = [], held = deferred();
 let app: App | undefined, timer: ReturnType<typeof setTimeout> | undefined, callback: (() => void) | undefined, calls = 0, settled = false, textSends = 0, onPoke: (() => void) | undefined, onLog: ((line: string) => void) | undefined;
 let seconds = Math.floor(Date.parse('2026-11-05T12:00:00+08:00') / 1000), plan: ReturnType<typeof pokeBackPlan>;
 for (let i = 0; i < 100 && !plan; i++) { seconds++; plan = pokeBackPlan(10001, seconds); } assert.ok(plan);
 const event = { post_type: 'notice' as const, notice_type: 'notify' as const, sub_type: 'poke' as const, self_id: 20000, user_id: 10001, target_id: 20000, time: seconds };
 try {
  for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], pokes: true, pokeBack: true, jokes: false, idioms: false,
   schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  globalThis.fetch = async () => { assert.fail('Network forbidden in synthetic poke owner fixture'); };
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
   const handle = oldTimeout(() => {}, 60_000); handle.unref(); handles.add(handle);
   if (fn.toString().includes('pokeTimers.delete')) { assert.equal(delay, plan!.delayMs); timer = handle; callback = () => fn(...args); }
   return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout> | number | string | undefined) => { if (typeof handle === 'object') cleared.add(handle); oldClearTimeout(handle); }) as typeof clearTimeout;
  app = startApp({ config, log: line => { logs.push(line); onLog?.(line); }, sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => { textSends++; return 900; }, pokeFriend: () => { calls++; onPoke?.(); return held.promise.then(() => { settled = true; }); } },
   pipeline: { now: () => seconds * 1000, generate: async () => '合成回应' },
  });
  await app.connected(20000); app.receivePoke(event); await settle(); assert.ok(callback); assert.ok(timer);
 } catch (error) {
  held.resolve(); await app?.stop(); for (const handle of handles) oldClearTimeout(handle); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout; globalThis.clearTimeout = oldClearTimeout;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-poke-owner-')); rmSync(root, { recursive: true, force: true }); throw error;
 }
 const owner = app;
 return { app: owner, dataDir, logs, held, event, calls: () => calls, settled: () => settled, textSends: () => textSends, onPoke: (fn: () => void) => { onPoke = fn; }, onLog: (fn: (line: string) => void) => { onLog = fn; },
  fire: () => { oldClearTimeout(timer); callback!(); }, timerCancelled: () => cleared.has(timer!),
  history: () => new ChatHistory(dataDir).load(10001),
  async cleanup() { held.resolve(); await owner.stop(); await settle(); for (const handle of handles) oldClearTimeout(handle); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout; globalThis.clearTimeout = oldClearTimeout;
   assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-poke-owner-')); rmSync(root, { recursive: true, force: true }); },
 };
}
function heldLease(dir: string) { assert.equal(existsSync(join(dir, 'bot.lock')), true); assert.throws(() => acquireLock(join(dir, 'bot.lock')), /运行|租约/); }

for (const failure of [false, true]) test(`已派戳回${failure ? '失败' : '成功'}ACK与诊断属于App.stop drain，不新造聊天历史`, async () => {
 const f = await fixture();
 try {
  const before = f.history(); assert.equal(before.length, 1); f.fire(); assert.equal(f.calls(), 1);
  const drain = f.app.stop(); assert.ok(drain instanceof Promise); assert.equal(f.app.stop(), drain); let drained = false; void drain.then(() => { drained = true; }); await settle();
  assert.equal(drained, false); heldLease(f.dataDir); const count = f.logs.length;
  if (failure) f.held.reject(Error('SYNTHETIC_POKE_ACK_FAILURE')); else f.held.resolve(); await drain; await settle();
  assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.calls(), 1); assert.equal(f.textSends(), 0); assert.deepEqual(f.history(), before);
  assert.equal(f.logs.slice(count).length, 1); assert.match(f.logs.slice(count)[0]!, failure ? /戳回去失败.*SYNTHETIC_POKE_ACK_FAILURE/ : /戳回去了/);
  const logs = [...f.logs]; f.app.receivePoke(f.event); f.fire(); await settle(); assert.equal(f.calls(), 1); assert.deepEqual(f.logs, logs);
 } finally { await f.cleanup(); }
});

test('未派戳回timer在stop取消，旧callback也不能重新派发', async () => {
 const f = await fixture();
 try { const history = f.history(); await f.app.stop(); assert.equal(f.timerCancelled(), true); f.fire(); await settle(); assert.equal(f.calls(), 0); assert.equal(f.textSends(), 0); assert.deepEqual(f.history(), history); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); }
 finally { await f.cleanup(); }
});

for (const failure of [false, true]) test(`pokeFriend扩展点同步重入stop仍拥有本次${failure ? '失败' : '成功'}确认`, async () => {
 const f = await fixture(), result: { drain?: Promise<void> } = {};
 try {
  f.onPoke(() => { result.drain = f.app.stop(); heldLease(f.dataDir); }); f.fire(); assert.ok(result.drain instanceof Promise); await settle(); heldLease(f.dataDir);
  if (failure) f.held.reject(Error('SYNTHETIC_SYNC_REENTRANT_POKE_FAILURE')); else f.held.resolve(); await result.drain;
  assert.equal(f.calls(), 1); assert.equal(f.textSends(), 0); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.history().filter(message => message.role === 'assistant').length, 0);
 } finally { await f.cleanup(); }
});

test('pokeFriend同步重入stop再throw也结束预登记，不从timer抛出或丢租约', async () => {
 const f = await fixture(), result: { drain?: Promise<void>; heldInside?: boolean } = {};
 try {
  const history = f.history(); f.onPoke(() => { result.drain = f.app.stop(); result.heldInside = existsSync(join(f.dataDir, 'bot.lock')); throw Error('SYNTHETIC_SYNC_POKE_THROW'); });
  assert.doesNotThrow(() => f.fire()); assert.ok(result.drain instanceof Promise); assert.equal(result.heldInside, true); await result.drain;
  assert.equal(f.calls(), 1); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.history(), history); assert.ok(f.logs.some(line => line.includes('SYNTHETIC_SYNC_POKE_THROW')));
 } finally { await f.cleanup(); }
});

test('已派戳回的诊断callback抛错不改变ACK或阻碍停止收尾', async () => {
 const f = await fixture();
 try {
  const history = f.history(); f.onLog(line => { if (line.includes('戳回去了')) throw Error('SYNTHETIC_DIAGNOSTIC_FAILURE'); });
  f.fire(); const drain = f.app.stop(); assert.ok(drain instanceof Promise); heldLease(f.dataDir); f.held.resolve(); await drain; await settle();
  assert.equal(f.settled(), true); assert.equal(f.calls(), 1); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.history(), history);
  assert.equal(f.logs.filter(line => line.includes('戳回去失败')).length, 0);
 } finally { await f.cleanup(); }
});
