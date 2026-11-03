import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { daylightFetcher, daylightPhase, parseOpenMeteoDaylight, useRealDaylight } from '../src/world/daylight.ts';
import { describeWorld, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);
const payload = (dates: string[]) => ({ daily: {
    time: dates,
    sunrise: dates.map(date => `${date}T06:30`),
    sunset: dates.map(date => `${date}T17:20`),
} });

afterEach(() => useRealDaylight(undefined));

describe('真实日照（ADR 0228）', () => {
    test('解析日出日落并按当前时刻分阶段', () => {
        assert.deepEqual(parseOpenMeteoDaylight(payload(['2026-11-03'])), {
            '2026-11-03': { sunrise: '2026-11-03T06:30', sunset: '2026-11-03T17:20' },
        });
        const times = { sunrise: '2026-11-03T06:30', sunset: '2026-11-03T17:20' };
        assert.equal(daylightPhase(times, at('2026-11-03T04:00')), '夜间');
        assert.equal(daylightPhase(times, at('2026-11-03T06:00')), '清晨');
        assert.equal(daylightPhase(times, at('2026-11-03T12:00')), '白天');
        assert.equal(daylightPhase(times, at('2026-11-03T16:30')), '傍晚');
        assert.equal(daylightPhase(times, at('2026-11-03T20:00')), '夜间');
        assert.throws(() => parseOpenMeteoDaylight({ daily: { time: ['2026-11-03'], sunrise: ['2026-11-03T06:30'], sunset: [] } }), /合法/);
    });

    test('缓存成功读取，失败保留旧缓存，过期不进入世界', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-daylight-'));
        let now = at('2026-11-03T12:00').getTime();
        let fail = false;
        const logs: string[] = [];
        const fetcher = daylightFetcher({
            dir: join(root, 'daylight'), now: () => now, log: message => logs.push(message), cacheMaxAgeMs: 60_000,
            fetchJson: async () => { if (fail) throw new Error('timeout'); return payload(['2026-11-03', '2026-11-04']); },
        });
        try {
            await fetcher.refresh();
            assert.deepEqual(fetcher.day('jinan', '2026-11-03', at('2026-11-03T12:00')), { sunrise: '06:30', sunset: '17:20', phase: '白天', real: true });
            fail = true;
            now += 30_000;
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T16:30'))?.phase, '傍晚');
            assert.ok(logs.some(line => line.includes('没取到') && line.includes('timeout')));
            now += 90_000;
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T16:30')), undefined);
            assert.equal(fetcher.status().places.jinan.stale, true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('进入世界描述，但不改变既有天气和生活事件', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        useRealDaylight({ day: () => ({ sunrise: '06:30', sunset: '17:20', phase: '傍晚', real: true }) });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T16:30'))!;
        assert.equal(now.daylight?.phase, '傍晚');
        assert.match(describeWorld(now, at('2026-10-20T16:30'))!, /日照：傍晚（06:30 日出，17:20 日落）/);
        assert.ok(now.weather, '天气仍然照旧存在');
    });
});
