// Synthetic real-App correctness probe for the "seen but no reply" reaction call.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic reaction checkpoint timeout'); await tick(); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

const schedule = {
 sleep: '23:30', wake: { early: '07:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 20 },
 holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
 free: { morning: ['合成上午'], afternoon: ['合成下午'], evening: ['合成晚上'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点',
};

async function observe(mode) {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-reaction-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, held = deferred(), logs = [], calls = [], now = Date.parse('2026-11-05T15:00:00+08:00');
 let app, stopInsideTransport, reactionSettled = false;
 try {
  const card = { spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } };
  for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify(card));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], schedule: true, reactions: true, jokes: false, idioms: false,
   moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  const history = new ChatHistory(dataDir);
  history.append(10001, { time: new Date(now - 300_000).toISOString(), role: 'user', content: '我要睡了', messageId: 11 });
  history.append(10001, { time: new Date(now - 240_000).toISOString(), role: 'assistant', content: '晚安啦', messageId: 12 });
  globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
  app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async () => { throw new Error('no text reply expected'); }, reactMessage: (messageId, emojiId) => {
    calls.push({ messageId, emojiId, leaseAtDispatch: existsSync(join(dataDir, 'bot.lock')) });
    if (mode === 'reentrant') stopInsideTransport = app.stop();
    return held.promise.then(() => { reactionSettled = true; if (mode === 'failure') throw new Error('SYNTHETIC_REACTION_FAILURE'); });
   } },
   pipeline: { now: () => now, settle: { quietMs: 0, maxMs: 0 }, waitUntil: async () => {}, generate: async () => { throw new Error('no synthetic generation expected'); } },
  });
  app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 13, real_seq: '100013', time: now / 1000,
   raw_message: '嗯嗯', sender: { user_id: 10001 }, message: '嗯嗯' });
  await until(() => calls.length === 1);
  let stopped = false; const drain = Promise.resolve(stopInsideTransport ?? app.stop()).then(() => { stopped = true; }); await settle();
  const before = logs.length, atStop = { stopped, lease: existsSync(join(dataDir, 'bot.lock')), calls: [...calls] };
  held.resolve(); await drain; await settle();
  assert.equal(atStop.stopped, false); assert.equal(atStop.lease, true); assert.equal(reactionSettled, true); assert.equal(calls.length, 1);
  assert.equal(logs.slice(before).some(line => line.includes('表情回应失败')), mode === 'failure');
  console.log(JSON.stringify({ correctnessProbe: true, mode, atStop, reactionSettled, lateLogs: logs.slice(before), finalCalls: calls }));
 } finally {
  held.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-reaction-owner-')); rmSync(root, { recursive: true, force: true });
 }
}

await observe('success');
await observe('failure');
await observe('reentrant');
