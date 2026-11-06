import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { startApp, WEATHER_REFRESH_MS, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { acquireLock } from '../src/platform/lock.ts';
import { realWeather } from '../src/world/weather.ts';
import { SYNTHETIC_WEATHER_PLACES } from './fixtures/card.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
function fixture(holdAt: number, fail = false, onFetch?: (app: App, index: number) => void) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-weather-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval, originalClearInterval = globalThis.clearInterval, originalFileOps = { ...fileOps };
    const timers = new Map<ReturnType<typeof setInterval>, { callback: () => void; ms: number }>(), writeLocks: boolean[] = [];
    let release!: () => void, calls = 0, app: App | undefined;
    const held = new Promise<void>(done => { release = done; });
    const cleanup = async () => {
        release(); await app?.stop(); await settle();
        Object.assign(fileOps, originalFileOps); globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-weather-stop-')); rmSync(root, { recursive: true, force: true });
    };
    try {
        const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2026-09-01', weeks: 30 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [], free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
        // 真实天气取卡上 weather.places 的地方（合成的两个）
        const SYNTHETIC_WEATHER = { rainChance: 0.3, temps: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), [10, 20]])), places: { school: SYNTHETIC_WEATHER_PLACES[0], home: SYNTHETIC_WEATHER_PLACES[1] } };
        const card = { spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule, world: { startDay: '2026-11-01', awayHolidays: [], people: [], events: [], weather: SYNTHETIC_WEATHER } } } } };
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify(card));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], schedule: false, moody: false, speechCheck: false, herDays: true, realWeather: true, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.setInterval = ((callback: () => void, ms: number) => { const timer = { unref() { return this; } } as ReturnType<typeof setInterval>; timers.set(timer, { callback, ms }); return timer; }) as typeof setInterval;
        globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { timers.delete(timer); }) as typeof clearInterval;
        globalThis.fetch = async input => {
            assert.equal(new URL(String(input)).origin, 'https://api.open-meteo.com', '所有外部请求必须被合成供应商拦截');
            const index = ++calls;
            if (onFetch) { assert.ok(app); onFetch(app, index); }
            if (index === holdAt) await held;
            if (fail && index >= holdAt) throw new Error('synthetic weather failure');
            return Response.json({ hourly: { time: ['2026-11-05T12:00'], temperature_2m: [18], precipitation: [0], weather_code: [0] } });
        };
        fileOps.writeFileSync = ((path: unknown, ...args: unknown[]) => {
            if (String(path).replaceAll('\\', '/').includes('/weather/')) writeLocks.push(existsSync(join(dataDir, 'bot.lock')));
            return Reflect.apply(originalFileOps.writeFileSync, fileOps, [path, ...args]);
        }) as typeof fileOps.writeFileSync;
        app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: () => {}, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => '合成回应' } });
        const weatherTick = [...timers.values()].find(timer => timer.ms === WEATHER_REFRESH_MS)?.callback;
        assert.ok(weatherTick);
        return { root, dataDir, app, calls: () => calls, release, weatherTick, timers, writeLocks, cleanup };
    } catch (error) {
        release(); void app?.stop(); Object.assign(fileOps, originalFileOps); globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClearInterval;
        throw error;
    }
}

for (const later of [false, true]) test(`正常App.stop等待${later ? '后续interval' : '启动首轮'}天气两城市刷新及原子落盘`, async () => {
    const f = fixture(later ? 3 : 1);
    try {
        await settle();
        if (later) {
            assert.equal(f.calls(), 2); assert.deepEqual(f.writeLocks, [true, true]);
            f.weatherTick(); f.weatherTick(); await tick(); assert.equal(f.calls(), 3, '并发tick复用一轮真实刷新');
        } else assert.equal(f.calls(), 1);
        const drain = f.app.stop();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true, '已派天气仍可写缓存，目录租约不能提前释放');
        assert.ok(drain instanceof Promise); assert.equal(f.app.stop(), drain);
        assert.equal(realWeather(), undefined, '停止后读侧立即撤销全局天气指针');
        let unexpectedRelease: (() => void) | undefined;
        try { assert.throws(() => { unexpectedRelease = acquireLock(join(f.dataDir, 'bot.lock')); }, /仍持有|运行|租约/); } finally { unexpectedRelease?.(); }
        f.release(); await drain; await settle();
        assert.equal(f.calls(), later ? 4 : 2, '已派一轮的第二城市保真完成，不能假取消');
        assert.deepEqual(f.writeLocks, later ? [true, true, true, true] : [true, true]);
        assert.ok(existsSync(join(f.dataDir, 'weather', 'school-town.json'))); assert.ok(existsSync(join(f.dataDir, 'weather', 'home-town.json')));
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.timers.size, 0);
        const before = f.calls(); f.weatherTick(); await settle(); assert.equal(f.calls(), before, '已排队的旧tick在停止后不能再派发');
        const release = acquireLock(join(f.dataDir, 'bot.lock')); release();
    } finally { await f.cleanup(); }
});

test('正常App.stop等待天气失败降级收尾，不造缓存且不因失败重启刷新', async () => {
    const f = fixture(1, true);
    try {
        await tick(); const drain = f.app.stop();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); assert.ok(drain instanceof Promise);
        f.release(); await drain; await settle();
        assert.equal(f.calls(), 2); assert.deepEqual(f.writeLocks, []); assert.equal(existsSync(join(f.dataDir, 'weather', 'school-town.json')), false);
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        f.weatherTick(); await settle(); assert.equal(f.calls(), 2);
    } finally { await f.cleanup(); }
});

test('fake fetch函数体同步stop时，interval刷新已登记并持续持有租约', async () => {
    let drain: Promise<void> | undefined, lockedInside: boolean | undefined;
    const f = fixture(3, false, (app, index) => {
        if (index !== 3) return;
        drain = app.stop(); lockedInside = existsSync(join(f.dataDir, 'bot.lock'));
    });
    try {
        await settle(); assert.equal(f.calls(), 2);
        f.weatherTick(); await tick();
        assert.equal(f.calls(), 3); assert.ok(drain instanceof Promise); assert.equal(lockedInside, true, '依赖回调内同步stop也不能漏掉本轮已派刷新');
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true);
        f.release(); await drain; await settle();
        assert.equal(f.calls(), 4); assert.deepEqual(f.writeLocks, [true, true, true, true]); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        f.weatherTick(); await settle(); assert.equal(f.calls(), 4);
    } finally { await f.cleanup(); }
});
