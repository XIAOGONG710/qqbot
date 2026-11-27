import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { DeviceService } from '../src/platform/device-service.ts';
import { ChatHistory } from '../src/memory/history.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成设备命令检查点超时'); await tick(); } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const event = (text: string, id = 1) => ({ post_type: 'message' as const, message_type: 'private' as const, sub_type: 'friend' as const, self_id: 20000, user_id: 10001,
    message_id: id, real_seq: String(100000 + id), time: Date.parse('2026-11-05T12:00:00+08:00') / 1000, raw_message: text, sender: { user_id: 10001 }, message: text });

// capture 走同意流程（她有权拒绝，2026-10-30）：他发 /屏幕 → 提给她 → 他再说一句 → 她写 <<同意>> 才去看；
// 只有以 SYNTHETIC_ 开头的那条（看完的结果）受 send / 同步 stop 的控制，「我跟她说了」和她的回复照常发
async function fixture(kind: 'reply' | 'capture', mode: 'success' | 'failure' | 'reentrant' | 'throw' | 'capture-held' | 'message' = 'success') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-device-command-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = [], sends: string[] = [], capture = deferred(), send = deferred();
    let app: App | undefined, captureEntered = false, leaseInsideTransport: boolean | undefined, stopInsideTransport: Promise<void> | undefined;
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], deviceControl: 'on', jokes: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWorld: false, proactive: 'off', media: false, recalls: true }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const service = { control: { menu: () => '', parse: (text: string) => ({ reply: text, proposals: [], rejected: [] }), commit: () => undefined }, hub: {},
        isOwnerCommand: () => false,
        owner: (text: string) => kind === 'reply' ? { kind: 'reply', text: 'SYNTHETIC_DEVICE_REPLY' } : text !== '/屏幕' ? { kind: 'none' } : { kind: 'capture', run: async () => {
            captureEntered = true; if (mode === 'capture-held') await capture.promise;
            return mode === 'message' ? { kind: 'message', text: '[他让你看了一眼他的电脑屏幕：SYNTHETIC_SCREEN]' } : { kind: 'reply', text: 'SYNTHETIC_CAPTURE_REPLY' };
        } }, stop: async () => {} } as unknown as DeviceService;
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { capture.resolve(); send.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-device-command-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, startDevices: async () => service,
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => {
                sends.push(text);
                if (!text.startsWith('SYNTHETIC_')) return 900;
                if (mode === 'reentrant' || mode === 'throw') { stopInsideTransport = Promise.resolve(app!.stop()); leaseInsideTransport = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_DEVICE_SYNC_THROW');
                await send.promise; if (mode === 'failure') throw new Error('SYNTHETIC_DEVICE_ACK_FAILURE'); return 900;
            } }, pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                if (kind === 'reply') throw new Error('no synthetic model expected');
                const all = messages.map(m => m.content).join('\n');
                return all.includes('SYNTHETIC_SCREEN') ? '你在忙呀' : all.includes('他刚才想看你的屏幕或摄像头') ? '好吧\n<<同意>>' : '嗯';
            } },
        });
        await app.connected(20000); await settle();
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, sends, capture, send, captureEntered: () => captureEntered, leaseInsideTransport: () => leaseInsideTransport, stopInsideTransport: () => stopInsideTransport,
        receive: () => owner.receive(event(kind === 'reply' ? '/设备' : '/屏幕')), history: () => new ChatHistory(dataDir), cleanup,
        /** 他发 /屏幕，等「我跟她说了」，再说一句让她答应 */
        consent: async () => { owner.receive(event('/屏幕')); await until(() => sends.includes('（我跟她说了，她愿意就给我看）')); owner.receive(event('给我看看嘛', 2)); } };
}

test('设备即时回复在App已停止后不派发', async () => {
    const f = await fixture('reply');
    try { await f.app.stop(); f.receive(); await settle(); assert.deepEqual(f.sends, []); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); }
    finally { await f.cleanup(); }
});

for (const mode of ['success', 'failure'] as const) test(`设备即时回复已派${mode === 'success' ? '成功' : '失败'}ACK收尾前不释放租约`, async () => {
    const f = await fixture('reply', mode);
    try {
        f.receive(); await until(() => f.sends.length === 1); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.send.resolve(); await drain;
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.history().load(10001).length, 0); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_DEVICE_ACK_FAILURE')), mode === 'failure');
    } finally { await f.cleanup(); }
});

for (const mode of ['reentrant', 'throw'] as const) test(`设备即时回复transport同步stop${mode === 'throw' ? '并throw' : ''}仍拥有本次发送`, async () => {
    const f = await fixture('reply', mode);
    try {
        f.receive(); await until(() => f.sends.length === 1); assert.equal(f.leaseInsideTransport(), true); f.send.resolve(); await f.stopInsideTransport();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_DEVICE_SYNC_THROW')), mode === 'throw'); assert.equal(f.history().load(10001).length, 0);
    } finally { await f.cleanup(); }
});

test('设备capture：她答应后看的结果尚未返回时停止，晚结果不派发', async () => {
    const f = await fixture('capture', 'capture-held');
    try {
        await f.consent(); await until(f.captureEntered); await until(() => f.sends.includes('好吧')); await f.app.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        f.capture.resolve(); await settle(); assert.equal(f.sends.some(text => text.startsWith('SYNTHETIC_')), false); assert.equal(f.history().load(10001).some(m => m.content.includes('SYNTHETIC')), false);
    } finally { await f.cleanup(); }
});

for (const mode of ['success', 'failure'] as const) test(`设备capture：她答应后的结果回复已派${mode === 'success' ? '成功' : '失败'}，ACK 收尾前不释放租约`, async () => {
    const f = await fixture('capture', mode);
    try {
        await f.consent(); await until(() => f.sends.includes('SYNTHETIC_CAPTURE_REPLY'));
        let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle(); assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true);
        f.send.resolve(); await drain; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.equal(f.history().load(10001).some(m => m.content === '/屏幕' || m.content.includes('SYNTHETIC')), false, '命令和结果小提示都不进聊天记录');
        assert.equal(f.logs.some(line => line.includes('SYNTHETIC_DEVICE_ACK_FAILURE')), mode === 'failure');
    } finally { await f.cleanup(); }
});

test('设备capture：结果回复的 transport 里同步 stop，仍先登记发送、ACK 后才收尾', async () => {
    const f = await fixture('capture', 'reentrant');
    try {
        await f.consent(); await until(() => f.sends.includes('SYNTHETIC_CAPTURE_REPLY')); assert.equal(f.leaseInsideTransport(), true);
        f.send.resolve(); await f.stopInsideTransport(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
    } finally { await f.cleanup(); }
});

test('设备capture：看到的描述作为他那条 /屏幕 交给回复器，她就此回他（ADR 0148 第 6 条；设备审查 G）', async () => {
    const f = await fixture('capture', 'message');
    try {
        await f.consent(); await until(() => f.sends.includes('你在忙呀'));
        const seen = f.history().load(10001).find(m => m.content.includes('SYNTHETIC_SCREEN'));
        assert.equal(seen?.role, 'user'); assert.equal(seen?.messageId, 1, '用他那条 /屏幕 的 message_id');
        assert.equal(seen?.time, new Date(event('/屏幕').time * 1000).toISOString());
        assert.equal(f.sends.some(text => text.includes('SYNTHETIC_SCREEN')), false, '描述本身不发给他');
    } finally { await f.cleanup(); }
});
