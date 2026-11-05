// Synthetic real-App correctness probe. Only the DSH dependency is replaced;
// no network is requested.
// --fail-first also verifies the rejected first pure request's queued successor.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const key = Symbol.for('qqbot.synthetic.dsh-owner-link'), oldLink = globalThis[key];
const linkUrl = new URL('../../../packages/bot/src/dsh-link.ts', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
    if (url === linkUrl) return { format: 'module', shortCircuit: true, source: `export const dshOptionsFromLlm=(o,p={})=>({...o,...p});export const createDshLink=()=>globalThis[Symbol.for('qqbot.synthetic.dsh-owner-link')]();` };
    return next(url, context);
} });
const { startApp } = await import('../../../packages/bot/src/platform/app.ts'); hooks.deregister();
const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 24; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic checkpoint timeout'); await tick(); } }

const root = mkdtempSync(join(tmpdir(), 'qqbot-app-dsh-owner-review-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
const oldFetch = globalThis.fetch, calls = [], sends = [], logs = [], now = Date.parse('2026-11-05T12:00:00+08:00');
const failure = process.argv.includes('--fail-first'); let app, release, firstCompleted = false;
const held = new Promise(done => { release = done; });
globalThis[key] = () => ({ model: 'synthetic', probe: async () => { throw new Error('no synthetic probe expected'); }, advise: async request => {
    const count = calls.length; calls.push(structuredClone(request));
    if (count === 0) { await held; firstCompleted = true; if (failure) throw new Error('SYNTHETIC_FIRST_ADVICE_FAILURE'); }
    return count === 0 ? 'SYNTHETIC_LATE_FIRST_ADVICE' : 'SYNTHETIC_SECOND_ADVICE';
} });
try {
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], dsh: { enabled: true }, jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
        transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sends.push(text); return 900; } }, pipeline: { now: () => now, generate: async () => { throw new Error('no synthetic chat generation expected'); } } });
    await app.connected(20000);
    const receive = (id, question) => app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: id, real_seq: String(100000 + id), time: now / 1000,
        raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: `/dsh ask ${question}` } }] });
    receive(1, '合成第一问'); await until(() => calls.length === 1); receive(2, '合成第二问');
    let stopped = false; const drain = Promise.resolve(app.stop()).then(() => { stopped = true; }); await settle();
    const atStop = { stopped, lease: existsSync(join(dataDir, 'bot.lock')), adviceCalls: calls.length, sends: sends.length, logs: logs.length };
    release(); await drain; await settle();
    const result = { correctnessProbe: true, failure, atStop, firstCompleted, lateAdviceCalls: calls.slice(atStop.adviceCalls),
        secondRequestIncludesLateAssistant: Boolean(calls[1]?.recentTurns?.some(turn => turn.role === 'assistant' && turn.content === 'SYNTHETIC_LATE_FIRST_ADVICE')),
        lateSends: sends.slice(atStop.sends), lateLogs: logs.slice(atStop.logs) };
    assert.equal(result.atStop.stopped, true); assert.equal(result.atStop.lease, false); assert.equal(result.atStop.adviceCalls, 1);
    assert.deepEqual(result.lateAdviceCalls, []); assert.equal(result.secondRequestIncludesLateAssistant, false); assert.deepEqual(result.lateSends, []); assert.deepEqual(result.lateLogs, []);
    console.log(JSON.stringify(result, null, 2));
} finally {
    release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; globalThis[key] = oldLink;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-dsh-owner-review-')); rmSync(root, { recursive: true, force: true });
}
