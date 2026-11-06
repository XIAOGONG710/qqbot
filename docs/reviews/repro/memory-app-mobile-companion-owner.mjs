// Synthetic real-App correctness probe for the mobile companion lifetime.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const linkKey = Symbol.for('qqbot.synthetic.mobile-companion-owner-link');
const globals = globalThis;
const dshUrl = new URL('../../../packages/bot/src/dsh-link.ts', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
    if (url === dshUrl) return { format: 'module', shortCircuit: true, source: `export const dshOptionsFromLlm=(o,p={})=>({...o,...p});export const createDshLink=()=>globalThis[Symbol.for('qqbot.synthetic.mobile-companion-owner-link')]();` };
    return next(url, context);
} });
const { startApp } = await import('../../../packages/bot/src/platform/app.ts'); hooks.deregister();

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise(done => setImmediate(done));
async function settle(rounds = 16) { for (let i = 0; i < rounds; i++) await tick(); }
async function until(check, label) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, label); await tick(); } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

const root = mkdtempSync(join(tmpdir(), 'qqbot-mobile-companion-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
const oldLink = globals[linkKey], held = deferred(), calls = [], logs = [];
let app;
try {
    globals[linkKey] = () => ({ model: 'synthetic', probe: async () => ({ ok: true, at: new Date(NOW).toISOString(), model: 'synthetic', latencyMs: 1 }), advise: async request => {
        calls.push(structuredClone(request));
        if (calls.length === 1) await held.promise;
        return `SYNTHETIC_MOBILE_REPLY_${calls.length}`;
    } });
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], dsh: { enabled: true }, jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
        transport: { friendHistory: async () => [], sendPrivateText: async () => 1 }, pipeline: { now: () => NOW, generate: async () => 'UNEXPECTED_CHAT' } });
    await app.connected(20000);
    const companion = app.mobileCompanion(); assert.ok(companion);
    const protocolNow = () => new Date().toISOString();
    const ticket = companion.issuePairing('synthetic-device');
    const session = 'synthetic-session';
    await companion.runtime.handle({ v: 1, requestId: 'req-hello-1', kind: 'hello', sentAt: protocolNow(), nonce: 'nonce-hello-1', body: { clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] } }, session);
    const first = companion.runtime.handle({ v: 1, requestId: 'req-message-1', kind: 'message.send', sentAt: protocolNow(), nonce: 'nonce-message-1', body: { kind: 'text', text: '第一条合成手机消息' } }, session);
    await until(() => calls.length === 1, 'first mobile advice did not start');
    await app.stop();
    const afterStop = { leaseReleased: !existsSync(join(dataDir, 'bot.lock')), exposed: Boolean(app.mobileCompanion()), status: companion.runtime.status() };
    const firstResult = await first;
    const secondResult = await companion.runtime.handle({ v: 1, requestId: 'req-message-2', kind: 'message.send', sentAt: protocolNow(), nonce: 'nonce-message-2', body: { kind: 'text', text: '第二条停止后消息' } }, session);
    assert.throws(() => companion.issuePairing('another-device'), /已经停止/);
    assert.throws(() => companion.pairing.issue('direct-device'), /已经停止/);
    assert.throws(() => companion.media.put({ clientId: 'direct-device', mime: 'image/png', data: Buffer.from('x'), bytes: 1 }), /已经停止/);
    const logCount = logs.length; held.resolve(); await settle();
    assert.deepEqual(afterStop, { leaseReleased: true, exposed: false, status: { connected: false, queued: 0, maxQueuedPerClient: 32 } });
    assert.deepEqual(firstResult, { accepted: false, error: '手机伴侣已经停止' });
    assert.deepEqual(secondResult, { accepted: false, error: '手机伴侣已经停止' });
    assert.equal(calls.length, 1); assert.equal(logs.length, logCount);
    console.log(JSON.stringify({ ok: true, afterStop, firstResult, secondResult, adviceCalls: calls.length, postStopPairingRejected: true, lateLogs: logs.length - logCount }));
} finally {
    held.resolve(); await app?.stop(); await settle(); globals[linkKey] = oldLink;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-mobile-companion-owner-')); rmSync(root, { recursive: true, force: true });
}
