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
const event = (text: string) => ({ post_type: 'message' as const, message_type: 'private' as const, sub_type: 'friend' as const, self_id: 20000, user_id: 10001,
    message_id: 1, real_seq: '100001', time: Date.parse('2026-11-05T12:00:00+08:00') / 1000, raw_message: text, sender: { user_id: 10001 }, message: text });

async function fixture(kind: 'reply' | 'capture', mode: 'success' | 'failure' | 'reentrant' | 'throw' | 'capture-held' = 'success') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-device-command-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = [], sends: string[] = [], capture = deferred(), send = deferred();
    let app: App | undefined, captureEntered = false, leaseInsideTransport: boolean | undefined, stopInsideTransport: Promise<void> | undefined;
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], deviceControl: 'on', jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false, recalls: true }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const service = { control: { menu: () => '', parse: (text: string) => ({ reply: text, proposals: [], rejected: [] }), commit: () => undefined }, hub: {},
        owner: () => kind === 'reply' ? { kind: 'reply', text: 'SYNTHETIC_DEVICE_REPLY' } : { kind: 'capture', run: async () => { captureEntered = true; if (mode === 'capture-held') await capture.promise; return { kind: 'reply', text: 'SYNTHETIC_CAPTURE_REPLY' }; } }, stop: async () => {} } as unknown as DeviceService;
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { capture.resolve(); send.resolve(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-device-command-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, startDevices: async () => service,
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => {
                sends.push(text);
                if (mode === 'reentrant' || mode === 'throw') { stopInsideTransport = Promise.resolve(app!.stop()); leaseInsideTransport = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_DEVICE_SYNC_THROW');
                await send.promise; if (mode === 'failure') throw new Error('SYNTHETIC_DEVICE_ACK_FAILURE'); return 900;
            } }, pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => { throw new Error('no synthetic model expected'); } },
        });
        await app.connected(20000); await settle();
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, sends, capture, send, captureEntered: () => captureEntered, leaseInsideTransport: () => leaseInsideTransport, stopInsideTransport: () => stopInsideTransport,
        receive: () => owner.receive(event(kind === 'reply' ? '/设备' : '/屏幕')), history: () => new ChatHistory(dataDir), cleanup };
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

test('设备capture纯来源尚未返回时停止，晚结果不派发', { skip: 'DSH 线的设备 capture 要她同意才执行，这条按「命令直接执行」写的测试测不到；待按同意流程重写（见 handoff）' }, async () => {
    const f = await fixture('capture', 'capture-held');
    try { f.receive(); await until(f.captureEntered); await f.app.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); f.capture.resolve(); await settle(); assert.deepEqual(f.sends, []); }
    finally { await f.cleanup(); }
});

for (const mode of ['success', 'failure'] as const) test(`设备capture回复已派${mode === 'success' ? '成功' : '失败'}ACK及入站收尾持有租约`, { skip: 'DSH 线的设备 capture 要她同意才执行，这条按「命令直接执行」写的测试测不到；待按同意流程重写（见 handoff）' }, async () => {
    const f = await fixture('capture', mode);
    try {
        f.receive(); await until(() => f.sends.length === 1); assert.equal(f.history().pendingIncoming(10001).length, 1);
        let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle(); assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true);
        f.send.resolve(); await drain; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.equal(f.history().pendingIncoming(10001).length, mode === 'success' ? 0 : 1); assert.equal(f.logs.some(line => line.includes('入站处理未完成')), mode === 'failure');
    } finally { await f.cleanup(); }
});

test('设备capture回复transport同步stop仍先登记发送与ACK后入站收尾', { skip: 'DSH 线的设备 capture 要她同意才执行，这条按「命令直接执行」写的测试测不到；待按同意流程重写（见 handoff）' }, async () => {
    const f = await fixture('capture', 'reentrant');
    try {
        f.receive(); await until(() => f.sends.length === 1); assert.equal(f.leaseInsideTransport(), true); assert.equal(f.history().pendingIncoming(10001).length, 1);
        f.send.resolve(); await f.stopInsideTransport(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.history().pendingIncoming(10001).length, 0);
    } finally { await f.cleanup(); }
});
