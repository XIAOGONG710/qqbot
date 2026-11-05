// Synthetic real-App correctness probe for status-triggered Hindsight health probes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic health checkpoint timeout'); await tick(); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

const root = mkdtempSync(join(tmpdir(), 'qqbot-health-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
const oldFetch = globalThis.fetch, waits = [deferred(), deferred()], logs = [], calls = [];
let first, second;
try {
 for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
 const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
  contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-health', timeoutMs: 5000, recallTimeoutMs: 100 },
  jokes: false, idioms: false, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
 globalThis.fetch = async (url, init) => {
  const index = calls.length; calls.push({ url: String(url), method: init?.method, lease: existsSync(join(dataDir, 'bot.lock')) });
  assert.ok(index < waits.length, 'only two synthetic health probes expected'); await waits[index].promise;
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
 };
 const options = { config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
  transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { generate: async () => { throw new Error('no synthetic model expected'); } } };
 first = startApp(options); const firstBefore = first.status(); await until(() => calls.length === 1);
 await first.stop(); const afterFirstStop = { lease: existsSync(join(dataDir, 'bot.lock')), health: first.status().memory?.health ?? null, logs: logs.length };

 second = startApp(options); const secondBefore = second.status(); await until(() => calls.length === 2);
 waits[0].resolve(); await settle();
 const afterFirstLateSuccess = { firstHealth: first.status().memory?.health ?? null, secondHealth: second.status().memory?.health ?? null, logs: logs.length };
 await second.stop(); const afterSecondStop = { lease: existsSync(join(dataDir, 'bot.lock')), health: second.status().memory?.health ?? null, logs: logs.length };
 waits[1].resolve(); await settle();
 const afterSecondLateSuccess = { health: second.status().memory?.health ?? null, logs: logs.length };
 const result = { correctnessProbe: true, calls, firstBefore: firstBefore.memory?.health ?? null, afterFirstStop,
  secondBefore: secondBefore.memory?.health ?? null, afterFirstLateSuccess, afterSecondStop, afterSecondLateSuccess };
 assert.equal(result.afterFirstStop.lease, false); assert.equal(result.afterFirstStop.health, null); assert.equal(result.afterFirstLateSuccess.firstHealth, null);
 assert.equal(result.afterFirstLateSuccess.secondHealth, null); assert.equal(result.afterSecondStop.lease, false); assert.equal(result.afterSecondLateSuccess.health, null);
 console.log(JSON.stringify(result, null, 2));
} finally {
 for (const wait of waits) wait.resolve(); await first?.stop(); await second?.stop(); await settle(); globalThis.fetch = oldFetch;
 assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-health-owner-')); rmSync(root, { recursive: true, force: true });
}
