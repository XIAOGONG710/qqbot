import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { startApp } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { DeviceService, DeviceServiceOptions } from '../src/platform/device-service.ts';
import { acquireLock } from '../src/platform/lock.ts';
import { realWeather } from '../src/world/weather.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

function failedConstruction() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-device-construction-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const startup = deferred<DeviceService>(), stopping = deferred<void>(), logs: string[] = [], timers = new Set<ReturnType<typeof setInterval>>();
    const originalFileOps = { ...fileOps }, originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
    let options: DeviceServiceOptions | undefined, stops = 0, sends = 0;
    const service = { stop: () => { stops++; return stopping.promise; } } as unknown as DeviceService;
    try {
        for (const tier of ['boyfriend', 'boyfriend-open', 'classmate']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-construction', timeoutMs: 1000, recallTimeoutMs: 100 },
            contextTurns: 1, deviceControl: 'on', schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.setInterval = ((_callback: unknown, _ms: unknown) => { const timer = { unref() { return this; } } as ReturnType<typeof setInterval>; timers.add(timer); return timer; }) as typeof setInterval;
        globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); }) as typeof clearInterval;
        fileOps.readDelaysMs = [0];
        fileOps.readFileSync = ((path: unknown, ...args: unknown[]) => {
            if (String(path).replaceAll('\\', '/').endsWith('/context/10001.json')) throw Object.assign(new Error('synthetic context EIO'), { code: 'EIO' });
            return Reflect.apply(originalFileOps.readFileSync, fileOps, [path, ...args]);
        }) as typeof fileOps.readFileSync;
        assert.throws(() => startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => { sends++; return 1; } }, pipeline: { generate: async () => '- 无' },
            startDevices: passed => { options = passed; return startup.promise; },
        }), /context.*暂时读不到/);
        assert.ok(options, '异步设备启动确实已派发');
    } catch (error) {
        Object.assign(fileOps, originalFileOps); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
        startup.resolve(service); stopping.resolve(); throw error;
    }
    Object.assign(fileOps, originalFileOps);
    return {
        root, dataDir, startup, stopping, service, options: options!, logs, timers, stops: () => stops, sends: () => sends,
        async cleanup() {
            startup.resolve(service); stopping.resolve(); await tick(); await tick();
            globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
            assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-device-construction-')); rmSync(root, { recursive: true, force: true });
        },
    };
}

test('构造失败等待已派设备启动及stop收尾，再释放目录租约', async () => {
    const f = failedConstruction();
    try {
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true, '未返回的设备启动仍拥有目录');
        let unexpectedRelease: (() => void) | undefined;
        try { assert.throws(() => { unexpectedRelease = acquireLock(join(f.dataDir, 'bot.lock')); }, /仍持有|运行|租约/); }
        finally { unexpectedRelease?.(); }
        f.startup.resolve(f.service); await tick(); await tick();
        assert.equal(f.stops(), 1, '构造失败后晚拿到的服务必须关闭，不能访问未初始化stopped');
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true, '设备关闭未确认前不能放行新实例');
        f.stopping.resolve(); await tick(); await tick();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        const release = acquireLock(join(f.dataDir, 'bot.lock')); release();
    } finally { await f.cleanup(); }
});

test('构造失败后设备晚回调不外发通知或日志，晚服务仍完成关闭', async () => {
    const f = failedConstruction();
    try {
        const before = [...f.logs];
        f.options.say('SYNTHETIC_LATE_DEVICE_NOTICE'); f.options.log('SYNTHETIC_LATE_DEVICE_CALLBACK');
        f.startup.resolve(f.service); await tick(); await tick();
        f.options.say('SYNTHETIC_LATE_DEVICE_NOTICE_AFTER_START'); f.options.log('SYNTHETIC_LATE_DEVICE_CALLBACK_AFTER_START');
        await tick();
        assert.equal(f.sends(), 0, '失败的App不能再通过授出的设备回调发送QQ通知');
        assert.deepEqual(f.logs, before, '晚设备结果及授出log不可污染已失败实例');
        assert.equal(f.stops(), 1); f.stopping.resolve(); await tick(); await tick();
    } finally { await f.cleanup(); }
});

for (const fail of [false, true]) test(`构造失败持有租约直至已派天气刷新${fail ? '失败降级' : '落盘'}收尾`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-construction-weather-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const originalFileOps = { ...fileOps }, originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval;
    const held = deferred<void>(), writeLocks: boolean[] = [], timers = new Set<ReturnType<typeof setInterval>>(); let calls = 0;
    const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2026-09-01', weeks: 30 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [], free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    try {
        const card = { spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule, world: { startDay: '2026-11-01', awayHolidays: [], people: [], events: [] } } } } };
        for (const tier of ['boyfriend', 'boyfriend-open', 'classmate']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify(card));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-weather-construction', timeoutMs: 1000, recallTimeoutMs: 100 },
            contextTurns: 1, schedule: false, moody: false, speechCheck: false, herDays: true, realWeather: true, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.setInterval = (() => { const timer = { unref() { return this; } } as ReturnType<typeof setInterval>; timers.add(timer); return timer; }) as typeof setInterval;
        globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); }) as typeof clearInterval;
        globalThis.fetch = async input => {
            const url = new URL(String(input)); assert.equal(url.origin, 'https://api.open-meteo.com');
            calls++; if (calls === 1) await held.promise;
            if (fail) throw new Error('synthetic weather unavailable');
            return Response.json({ hourly: { time: ['2026-11-05T12:00'], temperature_2m: [18], precipitation: [0], weather_code: [0] } });
        };
        fileOps.readDelaysMs = [0];
        fileOps.readFileSync = ((path: unknown, ...args: unknown[]) => {
            if (String(path).replaceAll('\\', '/').endsWith('/context/10001.json')) throw Object.assign(new Error('synthetic context EIO'), { code: 'EIO' });
            return Reflect.apply(originalFileOps.readFileSync, fileOps, [path, ...args]);
        }) as typeof fileOps.readFileSync;
        fileOps.writeFileSync = ((path: unknown, ...args: unknown[]) => {
            if (String(path).replaceAll('\\', '/').includes('/weather/')) writeLocks.push(existsSync(join(dataDir, 'bot.lock')));
            return Reflect.apply(originalFileOps.writeFileSync, fileOps, [path, ...args]);
        }) as typeof fileOps.writeFileSync;
        assert.throws(() => startApp({ config, log: () => {}, sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => '- 无' },
        }), /context.*暂时读不到/);
        assert.equal(existsSync(join(dataDir, 'bot.lock')), true);
        assert.equal(realWeather(), undefined, '失败实例立即撤销其全局天气读口');
        await tick(); assert.equal(calls, 1); assert.equal(existsSync(join(dataDir, 'bot.lock')), true);
        held.resolve(); for (let i = 0; i < 8; i++) await tick();
        assert.equal(calls, 2, '首轮已拥有的两地点刷新完整收尾');
        assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        if (fail) { assert.deepEqual(writeLocks, []); assert.equal(existsSync(join(dataDir, 'weather', 'jinan.json')), false); }
        else { assert.deepEqual(writeLocks, [true, true], '每份天气缓存仍在原租约内落盘'); assert.ok(existsSync(join(dataDir, 'weather', 'jinan.json'))); assert.ok(existsSync(join(dataDir, 'weather', 'qingdao.json'))); }
        assert.equal(timers.size, 0);
    } finally {
        held.resolve(); for (let i = 0; i < 8; i++) await tick();
        Object.assign(fileOps, originalFileOps); globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-construction-weather-')); rmSync(root, { recursive: true, force: true });
    }
});
