// Synthetic real-App probe for the connected() friendHistory backfill lifecycle.
// It records both late success and late failure without using real QQ or cards.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic backfill checkpoint timeout'); await tick(); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function observe(failure) {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-backfill-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
 const oldFetch = globalThis.fetch, held = deferred(), logs = [], replacementLogs = [], sends = [];
 let app, replacement, entered = false, connectedResolved = false, generated = 0;
 try {
  for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
  const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
   contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], jokes: false, idioms: false,
   schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
  globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
  const base = { config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
   pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => { generated++; return 'SYNTHETIC_REPLY'; } } };
  app = startApp({ ...base, transport: { friendHistory: async () => {
   entered = true; await held.promise; if (failure) throw new Error('SYNTHETIC_LATE_HISTORY_FAILURE');
   return [{ message_id: 101, real_seq: '100101', time: Date.parse('2026-11-05T11:59:00+08:00') / 1000, sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: 'SYNTHETIC_MISSED_MESSAGE' } }] }];
  }, sendPrivateText: async (_qq, text) => { sends.push(text); return 900; } } });
  const connecting = app.connected(20000).then(() => { connectedResolved = true; }); await until(() => entered);
  const logAtStop = logs.length, stopResult = app.stop(); assert.equal(stopResult, undefined, 'pure held history is not part of the write drain');
  const atStop = { connectedResolved, lease: existsSync(join(dataDir, 'bot.lock')), history: new ChatHistory(dataDir).load(10001), sends: [...sends], generated, lateLogs: logs.slice(logAtStop) };

  replacement = startApp({ ...base, log: line => replacementLogs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sends.push(`replacement:${text}`); return 901; } } });
  const replacementBefore = new ChatHistory(dataDir).load(10001);
  held.resolve(); await connecting; await settle();
  const afterLateResult = { connectedResolved, oldHistory: new ChatHistory(dataDir).load(10001), replacementHistory: new ChatHistory(dataDir).load(10001), replacementUnchanged: JSON.stringify(replacementBefore) === JSON.stringify(new ChatHistory(dataDir).load(10001)),
   sends: [...sends], generated, lateLogs: logs.slice(logAtStop), replacementLogs: replacementLogs.length, replacementLease: existsSync(join(dataDir, 'bot.lock')) };
  console.log(JSON.stringify({ correctnessProbe: true, failure, atStop, afterLateResult }));
 } finally {
  held.resolve(); await app?.stop(); await replacement?.stop(); await settle(); globalThis.fetch = oldFetch;
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-backfill-owner-')); rmSync(root, { recursive: true, force: true });
 }
}

await observe(false);
await observe(true);
