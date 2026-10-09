import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { dayPlan } from '../src/day-plan.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { dayFrom, mergeHours, parseOpenMeteo, useRealWeather, weatherFetcher, weatherText, type HourWeather, type RealWeather } from '../src/weather.ts';
import { describeWeather, describeWorld, worldAt } from '../src/world.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);
const pad = (n: number) => String(n).padStart(2, '0');
/** 一天 24 个钟头：rain 里的钟头下小雨，其余多云；气温 15 + 小时数的一半 */
function hoursOf(date: string, rain: number[] = []): Record<string, HourWeather> {
    return Object.fromEntries(Array.from({ length: 24 }, (_, h) => [`${date}T${pad(h)}`, { t: 15 + h / 2, p: rain.includes(h) ? 1.2 : 0, c: rain.includes(h) ? 61 : 2 }]));
}

afterEach(() => useRealWeather(undefined));

describe('真实天气（ADR 0048）', () => {
    test('天况代码的说法', () => {
        assert.equal(weatherText(0), '晴');
        assert.equal(weatherText(3), '阴');
        assert.equal(weatherText(61), '下小雨');
        assert.equal(weatherText(95), '打雷下雨');
    });

    test('一天：下没下雨只算到这一刻；还没下时写预报；过去的日子整天都算；凌晨还算前一天，「现在」取第二天的钟头', () => {
        const hours = { ...hoursOf('2026-10-16', [15, 16]), ...hoursOf('2026-10-17') };
        const morning = dayFrom(hours, '2026-10-16', at('2026-10-16T10:20:00'))!;
        assert.equal(morning.rain, false);
        assert.deepEqual(morning.rainHours, []);
        assert.deepEqual(morning.now, { text: '多云', temp: 20 });
        assert.equal(morning.later, '预报 15 点后有雨');
        assert.deepEqual([morning.low, morning.high], [15, 27]);

        const evening = dayFrom(hours, '2026-10-16', at('2026-10-16T17:30:00'))!;
        assert.equal(evening.rain, true);
        assert.deepEqual(evening.rainHours, [15, 16]);
        assert.equal(evening.later, undefined);

        const lateNight = dayFrom(hours, '2026-10-16', at('2026-10-17T01:10:00'))!;
        assert.deepEqual(lateNight.rainHours, [15, 16]);
        assert.deepEqual(lateNight.now, { text: '多云', temp: 16 }, '凌晨 1 点的「现在」是 17 号 01 时');
        assert.equal(dayFrom(hours, '2026-10-16', at('2026-10-18T12:00:00'))!.now, undefined, '过去的日子没有「现在」');

        const few = Object.fromEntries(Object.entries(hoursOf('2026-10-16')).slice(0, 8));
        assert.equal(dayFrom(few, '2026-10-16', at('2026-10-16T10:00:00')), undefined, '不到半天的数据不用');
    });

    test('时间块里的说法：真实的写现在、范围、下过没有、预报；生成的照旧', () => {
        assert.equal(describeWeather({ rain: false, low: 15, high: 27, real: true, now: { text: '多云', temp: 20 }, rainHours: [], later: '预报 15 点后有雨' }),
            '天气：现在多云，20℃（今天 15–27℃）；今天还没下过雨；预报 15 点后有雨');
        assert.equal(describeWeather({ rain: true, low: 15, high: 27, real: true, now: { text: '阴', temp: 23 }, rainHours: [15, 16] }),
            '天气：现在阴，23℃（今天 15–27℃）；今天下午下过雨');
        assert.equal(describeWeather({ rain: true, low: 15, high: 27, real: true, now: { text: '下小雨', temp: 22 }, rainHours: [15] }),
            '天气：现在下小雨，22℃（今天 15–27℃）');
        assert.equal(describeWeather({ rain: true, low: 11, high: 18 }), '天气：下雨，11–18℃');
    });

    test('并进存着的：过去 3 小时以上存过的不改，新的、近的照新的；40 天前的丢掉', () => {
        const stored = { '2026-10-16T08': { t: 10, p: 0, c: 2 }, '2026-10-16T13': { t: 10, p: 0, c: 2 }, '2026-09-01T08': { t: 30, p: 0, c: 0 } };
        const fetched = { '2026-10-16T08': { t: 99, p: 5, c: 63 }, '2026-10-16T13': { t: 21, p: 0, c: 3 }, '2026-10-16T20': { t: 18, p: 0, c: 3 } };
        const merged = mergeHours(stored, fetched, at('2026-10-16T14:30:00'));
        assert.deepEqual(merged, { '2026-10-16T08': { t: 10, p: 0, c: 2 }, '2026-10-16T13': { t: 21, p: 0, c: 3 }, '2026-10-16T20': { t: 18, p: 0, c: 3 } });
    });

    test('Open-Meteo 的回复：本地时间到小时；没有逐小时数据就报错', () => {
        assert.deepEqual(parseOpenMeteo({ hourly: { time: ['2026-10-16T08:00'], temperature_2m: [18.4], precipitation: [0], weather_code: [2] } }),
            { '2026-10-16T08': { t: 18.4, p: 0, c: 2 } });
        assert.throws(() => parseOpenMeteo({ error: true }), /逐小时/);
    });

    test('取数：存进目录，记下开始取的日子；之前的日子不换；取不到留着旧的', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-weather-'));
        const logs: string[] = [];
        let fail = false;
        const urls: string[] = [];
        const fetcher = weatherFetcher({
            dir, log: m => logs.push(m), now: () => at('2026-10-16T14:30:00').getTime(),
            fetchJson: async url => {
                urls.push(url);
                if (fail) throw new Error('timeout');
                const hours = { ...hoursOf('2026-10-15'), ...hoursOf('2026-10-16', [9]) };
                const keys = Object.keys(hours);
                return { hourly: { time: keys.map(k => `${k}:00`), temperature_2m: keys.map(k => hours[k]!.t), precipitation: keys.map(k => hours[k]!.p), weather_code: keys.map(k => hours[k]!.c) } };
            },
        });
        try {
            await fetcher.refresh();
            assert.equal(urls.length, 2);
            assert.match(urls[0]!, /latitude=36\.65&longitude=117\.12.*timezone=Asia%2FShanghai/);
            const saved = JSON.parse(readFileSync(join(dir, 'jinan.json'), 'utf8'));
            assert.equal(saved.since, '2026-10-16');
            assert.equal(fetcher.day('jinan', '2026-10-15', at('2026-10-16T14:30:00')), undefined, '开始取之前的日子照旧生成');
            assert.deepEqual(fetcher.day('jinan', '2026-10-16', at('2026-10-16T14:30:00'))!.rainHours, [9]);
            fail = true;
            await fetcher.refresh();
            assert.ok(logs.some(line => /济南没取到，照旧用存着的（timeout）/.test(line)));
            assert.deepEqual(fetcher.day('jinan', '2026-10-16', at('2026-10-16T14:30:00'))!.rainHours, [9]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('真实天气进她的世界（ADR 0048）', () => {
    const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
    const schedule = card.schedule!;
    const herWorld = card.herWorld!;
    const fake = (rain: number[]): RealWeather => ({
        day: (place, date, until) => (place === 'jinan' && date === '2026-10-20' ? dayFrom(hoursOf('2026-10-20', rain), date, until) : undefined),
    });

    test('有数据的日子用真实的（生成的那天下雨，实际没下）；没数据的照旧', () => {
        assert.equal(worldAt(herWorld, schedule, at('2026-10-20T21:00:00'))!.weather!.rain, true, '生成的 10-20 下雨');
        useRealWeather(fake([]));
        const now = worldAt(herWorld, schedule, at('2026-10-20T21:00:00'))!;
        assert.equal(now.weather!.rain, false);
        assert.equal(now.weather!.real, true);
        assert.match(describeWorld(now, at('2026-10-20T21:00:00'))!, /天气：现在多云，26℃（今天 15–27℃）；今天还没下过雨/);
        assert.ok(now.cat && 'fed' in now.cat.today, '没下雨，晚上下楼喂了猫');
        assert.equal(worldAt(herWorld, schedule, at('2026-10-21T21:00:00'))!.weather!.real, undefined, '没数据的日子照旧生成');
    });

    test('喂猫看那个钟头：上午下过雨照样去；喂的时候在下就不去', () => {
        useRealWeather(fake([]));
        const dry = worldAt(herWorld, schedule, at('2026-10-20T23:00:00'))!;
        const fed = (dry.cat!.today as { fed: Date }).fed;
        useRealWeather(fake([8, 9]));
        assert.ok('fed' in worldAt(herWorld, schedule, at('2026-10-20T23:00:00'))!.cat!.today);
        useRealWeather(fake([fed.getHours()]));
        assert.deepEqual(worldAt(herWorld, schedule, at('2026-10-20T23:00:00'))!.cat!.today, { skipped: 'rain' });
    });

    test('一天的打算看那个时段：下午才下的雨不改上午出门的打算', () => {
        const day = new Date(2026, 9, 20);
        const byWindow = (rainHours: number[]) => Object.fromEntries(dayPlan(schedule, herWorld.plans, day, { rain: rainHours.length > 0, rainHours })
            .map(slot => [slot.window, slot.because ?? '照打算']));
        assert.deepEqual(byWindow([15]), { morning: '照打算', afternoon: '下雨了', evening: '照打算' });
        assert.deepEqual(byWindow([9]), { morning: '下雨了', afternoon: '照打算', evening: '照打算' });
        assert.deepEqual(byWindow([]), { morning: '照打算', afternoon: '照打算', evening: '照打算' });
    });
});
