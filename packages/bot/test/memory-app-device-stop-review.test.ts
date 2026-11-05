import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { DeviceService, DeviceServiceOptions } from '../src/platform/device-service.ts';
import { acquireLock } from '../src/platform/lock.ts';
import { ChatHistory } from '../src/memory/history.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-device-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const beforeFetch = globalThis.fetch, startup = deferred<DeviceService>(), stopping = deferred<void>(), sending = deferred<number>(), logs: string[] = [];
    let options: DeviceServiceOptions | undefined, stops = 0, sends = 0, onSend: (() => void) | undefined;
    const service = { stop() { stops++; return stopping.promise; } } as unknown as DeviceService;
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], deviceControl: 'on', timeline: true,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { assert.fail('Network prohibited in synthetic device-stop fixture'); };
    const app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
        transport: { friendHistory: async () => [], sendPrivateText: () => { sends++; onSend?.(); return sending.promise; } },
        pipeline: { generate: async () => { assert.fail('No model in synthetic device-stop fixture'); } },
        startDevices: passed => { options = passed; return startup.promise; },
    });
    assert.ok(options);
    return { root, dataDir, app, startup, stopping, sending, service, options, logs, stops: () => stops, sends: () => sends, onSend: (callback: () => void) => { onSend = callback; },
        async cleanup() { startup.resolve(service); stopping.resolve(); sending.resolve(99); await app.stop(); await tick(); await tick(); globalThis.fetch = beforeFetch;
            assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-device-stop-')); rmSync(root, { recursive: true, force: true }); },
    };
}
function heldLock(dataDir: string) { assert.equal(existsSync(join(dataDir, 'bot.lock')), true); assert.throws(() => acquireLock(join(dataDir, 'bot.lock')), /运行|租约/); }

test('正常App.stop等待pending设备启动和晚服务stop，全部收尾才允许重启', async () => {
    const f = fixture();
    try {
        const drain = f.app.stop(); assert.ok(drain instanceof Promise); assert.equal(f.app.stop(), drain); heldLock(f.dataDir);
        f.startup.resolve(f.service); await tick(); assert.equal(f.stops(), 1); heldLock(f.dataDir);
        f.stopping.resolve(); await drain; assert.equal(f.stops(), 1); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        const release = acquireLock(join(f.dataDir, 'bot.lock')); release();
    } finally { await f.cleanup(); }
});

test('正常App.stop等待已启动设备的stop ACK，不重复stop服务', async () => {
    const f = fixture();
    try {
        f.startup.resolve(f.service); await tick();
        const drain = f.app.stop(); assert.ok(drain instanceof Promise); assert.equal(f.stops(), 1); assert.equal(f.app.stop(), drain); heldLock(f.dataDir);
        f.stopping.resolve(); await drain; assert.equal(f.stops(), 1); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
    } finally { await f.cleanup(); }
});

test('停止期间设备启动失败也收回租约，不调用不存在服务或晚写日志', async () => {
    const f = fixture();
    try {
        const drain = f.app.stop(); assert.ok(drain instanceof Promise); heldLock(f.dataDir); const before = [...f.logs];
        f.startup.reject(new Error('SYNTHETIC_DEVICE_START_FAILURE')); await drain;
        assert.equal(f.stops(), 0); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.logs, before);
    } finally { await f.cleanup(); }
});

test('设备stop失败保留App既有收尾诊断，等待实际拒绝后释放且不重试stop', async () => {
    const f = fixture();
    try {
        f.startup.resolve(f.service); await tick();
        const drain = f.app.stop(); assert.ok(drain instanceof Promise); heldLock(f.dataDir);
        f.stopping.reject(new Error('SYNTHETIC_DEVICE_STOP_FAILURE')); await drain;
        assert.equal(f.stops(), 1); assert.equal(f.app.stop(), drain); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.ok(f.logs.some(line => line.includes('停止时持久收尾未确认')));
    } finally { await f.cleanup(); }
});

for (const failure of [false, true]) test(`正常App.stop等待已派设备通知${failure ? '失败' : '成功'}确认，不再接收新回调且不伪造聊天历史`, async () => {
    const f = fixture();
    try {
        f.startup.resolve(f.service); f.stopping.resolve(); await tick();
        f.options.say('合成已派设备通知'); assert.equal(f.sends(), 1);
        const drain = f.app.stop(); assert.ok(drain instanceof Promise); heldLock(f.dataDir); const before = [...f.logs];
        f.options.say('合成停止后设备通知'); f.options.log('SYNTHETIC_LATE_DEVICE_LOG'); await tick();
        assert.equal(f.sends(), 1); assert.deepEqual(f.logs, before); heldLock(f.dataDir);
        if (failure) f.sending.reject(new Error('SYNTHETIC_DEVICE_SEND_FAILURE')); else f.sending.resolve(99);
        await drain; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.stops(), 1);
        assert.equal(new ChatHistory(f.dataDir).load(10001).length, 0, '既有设备提示不写聊天历史，本批不猜造发送记录');
    } finally { await f.cleanup(); }
});

for (const failure of [false, true]) test(`传输公开扩展点同步重入App.stop也等待本次通知${failure ? '失败' : '成功'}确认`, async () => {
    const f = fixture(); let drain: Promise<void> | undefined;
    try {
        f.startup.resolve(f.service); f.stopping.resolve(); await tick();
        f.onSend(() => { drain = f.app.stop(); });
        f.options.say('合成同步重入通知'); assert.ok(drain instanceof Promise); assert.equal(f.sends(), 1);
        await tick(); heldLock(f.dataDir);
        if (failure) f.sending.reject(new Error('SYNTHETIC_REENTRANT_ACK_FAILURE')); else f.sending.resolve(99);
        await drain; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.stops(), 1);
    } finally { await f.cleanup(); }
});

test('传输同步重入stop并抛错仍结束本次预登记，停止后不晚写诊断', async () => {
    const f = fixture(); let drain: Promise<void> | undefined, before: string[] = [];
    try {
        f.startup.resolve(f.service); f.stopping.resolve(); await tick();
        f.onSend(() => { drain = f.app.stop(); before = [...f.logs]; throw new Error('SYNTHETIC_REENTRANT_TRANSPORT_THROW'); });
        f.options.say('合成同步抛错通知'); assert.ok(drain instanceof Promise);
        await drain; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.stops(), 1); assert.deepEqual(f.logs, before);
    } finally { await f.cleanup(); }
});
