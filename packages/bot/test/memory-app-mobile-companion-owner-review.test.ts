import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const linkKey = Symbol.for('qqbot.synthetic.mobile-companion-owner-review-link');
const globals = globalThis as unknown as Record<symbol, unknown>;
const dshUrl = new URL('../src/dsh-link.ts', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
    if (url === dshUrl) return { format: 'module', shortCircuit: true, source: `export const dshOptionsFromLlm=(o,p={})=>({...o,...p});export const createDshLink=()=>globalThis[Symbol.for('qqbot.synthetic.mobile-companion-owner-review-link')]();` };
    return next(url, context);
} });
const { startApp } = await import('../src/platform/app.ts'); hooks.deregister();

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle(rounds = 16): Promise<void> { for (let i = 0; i < rounds; i++) await tick(); }
async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!check()) { assert.ok(Date.now() < deadline, `synthetic timeout: ${label}`); await tick(); }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    return { promise: new Promise<void>(done => { resolve = done; }), resolve };
}

function parsedConfig(root: string, dataDir: string) {
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({
        spec: 'chara_card_v2', data: { name: '合成角色' },
    }));
    return parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], dsh: { enabled: true },
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false,
        jokes: false, idioms: false,
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
}

function envelope(kind: 'hello' | 'message.send', requestId: string, nonce: string, body: unknown) {
    return { v: 1 as const, requestId, kind, sentAt: new Date().toISOString(), nonce, body };
}

async function fixture(advise: (request: { question: string }) => Promise<string>) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-mobile-companion-owner-test-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const previous = globals[linkKey], logs: string[] = [];
    let app: App | undefined;
    globals[linkKey] = () => ({ model: 'synthetic', probe: async () => ({ ok: true, at: new Date(NOW).toISOString(), model: 'synthetic', latencyMs: 1 }), advise });
    const cleanup = async () => {
        await app?.stop(); await settle(); globals[linkKey] = previous;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-mobile-companion-owner-test-'));
        rmSync(root, { recursive: true, force: true });
    };
    try {
        app = startApp({ config: parsedConfig(root, dataDir), log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => NOW, generate: async () => { throw new Error('unexpected synthetic chat generation'); } },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    return { app, dataDir, logs, cleanup };
}

async function pair(app: App, clientId = 'synthetic-device') {
    const companion = app.mobileCompanion(); assert.ok(companion);
    const session = 'synthetic-session', ticket = companion.issuePairing(clientId);
    const hello = await companion.runtime.handle(envelope('hello', 'req-hello-1', 'nonce-hello-1', {
        clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'],
    }), session);
    assert.equal(hello.accepted, true);
    return { companion, session };
}

test('真实App停止取消已派手机伴侣纯模型等待，不返回迟到回复', async () => {
    const held = deferred(), calls: string[] = [];
    const f = await fixture(async request => { calls.push(request.question); await held.promise; return 'SYNTHETIC_LATE_MOBILE_REPLY'; });
    try {
        const { companion, session } = await pair(f.app);
        const pending = companion.runtime.handle(envelope('message.send', 'req-message-1', 'nonce-message-1', { kind: 'text', text: '合成手机消息' }), session);
        await until(() => calls.length === 1, 'mobile advice entered');
        await f.app.stop();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.equal(f.app.mobileCompanion(), undefined);
        assert.deepEqual(companion.runtime.status(), { connected: false, queued: 0, maxQueuedPerClient: 32 });
        assert.deepEqual(await pending, { accepted: false, error: '手机伴侣已经停止' });
        const logs = [...f.logs]; held.resolve(); await settle(32);
        assert.deepEqual(f.logs, logs, '迟到模型结果不能再写停止实例诊断');
    } finally { held.resolve(); await f.cleanup(); }
});

test('停止后旧集成对象不再接受消息、签发配对码或暴露会话', async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return 'SYNTHETIC_MOBILE_REPLY'; });
    try {
        const { companion, session } = await pair(f.app);
        await f.app.stop();
        assert.throws(() => companion.issuePairing('another-device'), /已经停止/);
        assert.equal(companion.runtime.clientForSession(session), undefined);
        assert.deepEqual(companion.runtime.takeDownlinks('synthetic-device'), []);
        const rejected = await companion.runtime.handle(envelope('message.send', 'req-message-2', 'nonce-message-2', { kind: 'text', text: '停止后消息' }), session);
        assert.deepEqual(rejected, { accepted: false, error: '手机伴侣已经停止' });
        assert.equal(calls, 0);
    } finally { await f.cleanup(); }
});

test('未停止的手机伴侣仍保持正常配对、DSH回复和有限上下文', async () => {
    const calls: Array<{ question: string }> = [];
    const f = await fixture(async request => { calls.push(structuredClone(request)); return `回：${request.question}`; });
    try {
        const { companion, session } = await pair(f.app);
        const first = await companion.runtime.handle(envelope('message.send', 'req-message-3', 'nonce-message-3', { kind: 'text', text: '在吗' }), session);
        assert.equal(first.accepted, true);
        if (first.accepted) assert.deepEqual(first.response?.body, { kind: 'text', text: '回：在吗' });
        assert.deepEqual(calls.map(call => call.question), ['在吗']);
        assert.equal(companion.runtime.status().connected, true);
    } finally { await f.cleanup(); }
});
