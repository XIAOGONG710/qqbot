import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { dayFrom, mergeHours, openMeteoProvider, weatherFetcher, type HourWeather } from '../src/world/weather.ts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-weather-review-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const date = '2026-11-05';
const at = (clock: string) => new Date(`${date}T${clock}:00+08:00`);
const hours = (temp = 20, observed = false): Record<string, HourWeather> => Object.fromEntries(Array.from({ length: 24 }, (_, h) => [
    `${date}T${String(h).padStart(2, '0')}`, { t: temp, p: 0, c: 0, ...(observed ? { o: 1 as const } : {}) },
]));

test('回放不能读取下一小时的降水实况；到观测时刻才确认前一小时下过雨', () => {
    const data = hours(20, true); data[`${date}T15`]!.p = 1;
    assert.deepEqual(dayFrom(data, date, at('14:00'))!.rainHours, []);
    assert.deepEqual(dayFrom(data, date, at('14:59'))!.rainHours, []);
    assert.deepEqual(dayFrom(data, date, at('15:00'))!.rainHours, [14]);
    data[`${date}T14`]!.c = 61;
    assert.deepEqual(dayFrom(data, date, at('14:00'))!.rainHours, [14], '14点天况已经观察到雨时无需等待15点降水');
});

test('保留 ADR0048 的历史补数政策，已观测小时不可覆盖', () => {
    const old = hours(); delete old[`${date}T22`];
    const tomorrow = new Date('2026-11-06T09:00:00+08:00');
    assert.deepEqual(mergeHours(old, { [`${date}T22`]: { t: 21, p: 1, c: 61 } }, tomorrow)[`${date}T22`], { t: 21, p: 1, c: 61, o: 1 });
    const observed = hours(20, true);
    assert.deepEqual(mergeHours(observed, hours(30), tomorrow), observed);
});

test('坏缓存拒绝使用且刷新不能覆盖，错误不包含坏 JSON 原文；合法旧缓存保持兼容', async () => {
    for (const bad of [
        { since: date, hours: Object.fromEntries(Object.keys(hours()).map(k => [k, { t: 'bad', p: 0, c: 0 }])) },
        { since: '2026-02-30', hours: hours() },
        { since: date, hours: { [`${date}T24`]: { t: 20, p: 0, c: 0 } } },
        { since: date, hours: { [`${date}T01`]: { t: 20, p: 0, c: 0, o: 2 } } },
        { since: date, fetchedAt: 'not-a-time', hours: hours() },
        'BROKEN_PRIVATE_CACHE_JSON',
    ]) {
        const dir = fixture(); const file = join(dir, 'jinan.json');
        const text = typeof bad === 'string' ? bad : JSON.stringify(bad); writeFileSync(file, text);
        const logs: string[] = [];
        const fetcher = weatherFetcher({ dir, log: line => logs.push(line), now: () => at('03:00').getTime(), provider: { id: 'fake', fetchHourly: async () => hours() } });
        assert.equal(fetcher.day('jinan', date, at('12:00')), undefined);
        assert.ok(fetcher.status().places.jinan.error);
        await fetcher.refresh();
        assert.equal(readFileSync(file, 'utf8'), text);
        assert.ok(logs.every(line => !line.includes('BROKEN_PRIVATE_CACHE_JSON')));
        // 原文件修好后不必重建 fetcher，就可以正常重试。
        writeFileSync(file, JSON.stringify({ since: date, hours: hours(21, true) }));
        assert.equal(fetcher.day('jinan', date, at('12:00'))!.low, 21);
    }
});

test('供应商忽略 AbortSignal 也会超时释放刷新，迟到旧结果不能覆盖新缓存', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let attempts = 0; let firstSignal: AbortSignal | undefined;
    const fetcher = weatherFetcher({ dir: fixture(), log: () => {}, now: () => at('03:00').getTime(), timeoutMs: 10,
        provider: { id: 'slow', fetchHourly: async request => {
            if (request.place === 'jinan' && ++attempts === 1) { firstSignal = request.signal; await gate; return hours(10); }
            return hours(30);
        } } });
    const first = fetcher.refresh();
    assert.equal(fetcher.refresh(), first);
    let guard: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([first.then(() => 'done'), new Promise<string>(resolve => { guard = setTimeout(() => resolve('stuck'), 300); })]);
    try {
        assert.equal(outcome, 'done');
        assert.equal(firstSignal?.aborted, true);
        assert.match(fetcher.status().places.jinan.error ?? '', /超时/);
        await fetcher.refresh();
        assert.equal(fetcher.day('jinan', date, at('12:00'))!.low, 30);
        release(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(fetcher.day('jinan', date, at('12:00'))!.low, 30);
    } finally { clearTimeout(guard); release(); await first; }
});

test('Open-Meteo 供应商遵守调用方取消，已取消时不发请求', async () => {
    let called = 0; const controller = new AbortController(); controller.abort();
    const provider = openMeteoProvider({ fetchJson: async () => { called++; return { hourly: { time: [], temperature_2m: [], precipitation: [], weather_code: [] } }; } });
    await assert.rejects(provider.fetchHourly({ place: 'jinan', latitude: 36.65, longitude: 117.12, signal: controller.signal }));
    assert.equal(called, 0);
});
