// Synthetic real-App correctness probe for the asynchronous device capture ->
// direct text reply chain.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic device checkpoint timeout'); await tick(); } }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function observe(mode) {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-device-handled-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, capture = deferred(), send = deferred(), logs = [], sends = [];
 let app, serviceStopped = 0, captureEntered = false, sendSettled = false, stopInsideTransport;
 try {
  for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], deviceControl: 'on', jokes: false, idioms: false,
   schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  const service = {
   control: { menu: () => '', parse: text => ({ reply: text, proposals: [], rejected: [] }), commit: () => undefined }, hub: {},
   owner: text => text === '/屏幕' ? { kind: 'capture', run: async () => { captureEntered = true; if (mode === 'capture-held') await capture.promise; return { kind: 'reply', text: 'SYNTHETIC_CAPTURE_REPLY' }; } } : { kind: 'none' },
   stop: async () => { serviceStopped++; },
  };
  globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
  app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   startDevices: async () => service,
   transport: { friendHistory: async () => [], sendPrivateText: (_qq, text) => {
    sends.push({ text, leaseAtDispatch: existsSync(join(dataDir, 'bot.lock')) });
    if (mode === 'reentrant-send') stopInsideTransport = app.stop();
    return send.promise.then(() => { sendSettled = true; if (mode === 'send-failure') throw new Error('SYNTHETIC_CAPTURE_SEND_FAILURE'); return 900; });
   } },
   pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => { throw new Error('no synthetic chat generation expected'); } },
  });
  await app.connected(20000); await settle();
  app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: Date.parse('2026-11-05T12:00:00+08:00') / 1000,
   raw_message: '/屏幕', sender: { user_id: 10001 }, message: '/屏幕' });
  await until(() => captureEntered);
  if (mode !== 'capture-held') await until(() => sends.length === 1);
  let stopped = false; const drain = Promise.resolve(stopInsideTransport ?? app.stop()).then(() => { stopped = true; }); await settle();
  const before = logs.length, atStop = { stopped, lease: existsSync(join(dataDir, 'bot.lock')), sends: [...sends], serviceStopped };
  capture.resolve(); send.resolve(); await drain; await settle();
  const result = { correctnessProbe: true, mode, atStop, sendSettled, sends: [...sends], lateLogs: logs.slice(before) };
  if (mode === 'capture-held') { assert.equal(result.atStop.stopped, true); assert.equal(result.atStop.lease, false); assert.deepEqual(result.sends, []); }
  else { assert.equal(result.atStop.stopped, false); assert.equal(result.atStop.lease, true); assert.equal(result.sends.length, 1); assert.equal(result.sendSettled, true); }
  if (mode === 'send-failure') assert.equal(result.lateLogs.some(line => line.includes('入站处理未完成')), true);
  console.log(JSON.stringify(result));
 } finally {
  capture.resolve(); send.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-device-handled-owner-')); rmSync(root, { recursive: true, force: true });
 }
}

await observe('capture-held');
await observe('send-success');
await observe('send-failure');
await observe('reentrant-send');
