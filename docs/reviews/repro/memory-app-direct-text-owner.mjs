// Synthetic correctness probe for direct /主动 reason notices.
// Only the /主动 -> "主动消息没开" command reply chain is exercised.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';
const at = Date.parse('2026-11-05T12:00:00+08:00');
const turn = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await turn(); }
async function observe(stopBeforeDispatch) {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-direct-text-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, logs = [], sends = []; let app, release, settled = false;
 const held = new Promise(done => { release = done; });
 try {
  for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], proactive: 'off', jokes: false, idioms: false,
   schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  globalThis.fetch = async () => { throw Error('unexpected synthetic network'); };
  app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   transport: { friendHistory: async () => [], sendPrivateText: async (qq, body) => { sends.push({ qq, body, heldLease: existsSync(join(dataDir, 'bot.lock')) }); await held; settled = true; throw Error('SYNTHETIC_DIRECT_COMMAND_SEND_FAILURE'); } },
   pipeline: { now: () => at, generate: async () => { assert.fail('No model expected for /主动 with proactive off'); } },
  });
  await app.connected(20000);
  app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, time: at / 1000, message_id: 1, message: '/主动', raw_message: '/主动', sender: { user_id: 10001 } });
  if (!stopBeforeDispatch) { await settle(); assert.equal(sends.length, 1); }
  let stopResolved = false; const drain = Promise.resolve(app.stop()).then(() => { stopResolved = true; });
  await settle(); const before = logs.length;
  const observations = { stopBeforeDispatch, stopResolvedWhileCommandSendHeld: stopResolved, leaseWhileCommandSendHeld: existsSync(join(dataDir, 'bot.lock')), sends: [...sends] };
  release(); await drain; await settle();
  const historyCount = new ChatHistory(dataDir).load(10001).length;
  const result = { correctnessProbe: true, chain: '/主动 when proactive is off', ...observations, sendActuallySettled: settled, lateLogs: logs.slice(before), historyCount };
  if (stopBeforeDispatch) { assert.equal(result.sends.length, 0); assert.equal(result.stopResolvedWhileCommandSendHeld, true); assert.equal(result.leaseWhileCommandSendHeld, false); }
  else { assert.equal(result.sends.length, 1); assert.equal(result.stopResolvedWhileCommandSendHeld, false); assert.equal(result.leaseWhileCommandSendHeld, true); assert.equal(result.sendActuallySettled, true); assert.equal(result.lateLogs.length, 1); }
  assert.equal(result.historyCount, 0); console.log(JSON.stringify(result));
 } finally {
  release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-direct-text-owner-')); rmSync(root, { recursive: true, force: true });
 }
}
await observe(true); await observe(false);
