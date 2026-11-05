// Synthetic real-App correctness probe for an already-dispatched poke-back.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { pokeBackPlan } from '../../../packages/bot/src/social/pokes.ts';
const turn = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await turn(); }
async function observe(failure) {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-app-notice-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout;
 const fakeClockHandles = new Set();
 let app, release, entered = false, completed = false, callback, timer;
 const logs = [], held = new Promise(done => { release = done; });
 let seconds = Math.floor(Date.parse('2026-11-05T12:00:00+08:00') / 1000), plan;
 for (let i = 0; i < 100 && !plan; i++) { seconds++; plan = pokeBackPlan(10001, seconds); }
 assert.ok(plan);
 try {
  for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], pokes: true, pokeBack: true, jokes: false, idioms: false,
   schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  globalThis.fetch = async () => { throw Error('unexpected synthetic network'); };
  // Capture this exact owned delay without waiting, using a real timer handle so
  // the App's existing clearTimeout behaviour remains meaningful.
  globalThis.setTimeout = (fn, delay, ...args) => {
   if (typeof fn === 'function' && fn.toString().includes('pokeTimers.delete')) { assert.equal(delay, plan.delayMs); callback = () => fn(...args); timer = oldTimeout(() => {}, 60_000); timer.unref(); fakeClockHandles.add(timer); return timer; }
   const handle = oldTimeout(fn, delay, ...args); fakeClockHandles.add(handle); return handle;
  };
  app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => 900, pokeFriend: async () => { entered = true; await held; completed = true; if (failure) throw Error('SYNTHETIC_LATE_POKE_FAILURE'); } },
   pipeline: { now: () => seconds * 1000, generate: async () => '合成回应' },
  });
  await app.connected(20000);
  app.receivePoke({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 20000, user_id: 10001, target_id: 20000, time: seconds });
  assert.equal(typeof callback, 'function'); clearTimeout(timer); callback(); assert.equal(entered, true);
  let stopped = false; const drain = Promise.resolve(app.stop()).then(() => { stopped = true; }); await settle();
  const leaseWhilePokeHeld = existsSync(join(dataDir, 'bot.lock')), stopResolvedWhilePokeHeld = stopped, count = logs.length;
  assert.equal(leaseWhilePokeHeld, true); assert.equal(stopResolvedWhilePokeHeld, false);
  release(); await drain; await settle();
  const outcomeLogs = logs.slice(count); assert.equal(completed, true); assert.equal(outcomeLogs.length, 1);
  assert.match(outcomeLogs[0], failure ? /戳回去失败.*SYNTHETIC_LATE_POKE_FAILURE/ : /戳回去了/);
  console.log(JSON.stringify({ correctnessProbe: true, failure, entered, leaseWhilePokeHeld, stopResolvedWhilePokeHeld, actualPokeSettled: completed, outcomeLogs }));
 } finally {
  release(); clearTimeout(timer); await app?.stop(); await settle(); for (const handle of fakeClockHandles) clearTimeout(handle); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-notice-owner-')); rmSync(root, { recursive: true, force: true });
 }
}
await observe(false); await observe(true);
