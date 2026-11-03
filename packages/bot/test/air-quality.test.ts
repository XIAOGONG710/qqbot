import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { airQualityCategory, airQualityFetcher, parseOpenMeteoAirQuality, useRealAirQuality } from '../src/world/air-quality.ts';
import { describeWorld, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);
const hours = (date: string) => Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
const payload = (date: string) => {
    const time = hours(date);
    return { hourly: { time, pm2_5: time.map((_, h) => 12 + h), pm10: time.map((_, h) => 25 + h), us_aqi: time.map((_, h) => 35 + h) } };
};

afterEach(() => useRealAirQuality(undefined));

describe('真实空气质量（ADR 0227）', () => {
    test('类别和响应字段校验', () => {
        assert.equal(airQualityCategory(20), '优');
        assert.equal(airQualityCategory(80), '良');
        assert.equal(airQualityCategory(180), '中度污染');
        assert.deepEqual(parseOpenMeteoAirQuality(payload('2026-11-03')), {
            '2026-11-03T00': { pm25: 12, pm10: 25, aqi: 35 },
            ...Object.fromEntries(hours('2026-11-03').slice(1).map((key, i) => [key.slice(0, 13), { pm25: 13 + i, pm10: 26 + i, aqi: 36 + i }])),
        });
        assert.throws(() => parseOpenMeteoAirQuality({ hourly: { time: ['2026-11-03T00:00'], pm2_5: [], pm10: [1], us_aqi: [1] } }), /合法/);
    });

    test('缓存当前观测、失败保留旧值，预报不当成已经发生', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-air-quality-'));
        let now = at('2026-11-03T03:30:00').getTime();
        let fail = false;
        const logs: string[] = [];
        const fetcher = airQualityFetcher({
            dir: join(root, 'air-quality'), now: () => now, log: message => logs.push(message),
            fetchJson: async () => { if (fail) throw new Error('timeout'); return payload('2026-11-03'); },
        });
        try {
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan', '2026-11-04', at('2026-11-04T02:30:00')), undefined, '未来日期没有已观测小时时不写空气质量');
            const first = fetcher.day('jinan', '2026-11-03', at('2026-11-03T03:30:00'))!;
            assert.deepEqual(first, { pm25: 15, pm10: 28, aqi: 38, category: '优', observedAt: '2026-11-03T03:00', real: true });
            const fetchedAt = now;
            now -= 120_000;
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T03:30:00')), undefined, '缓存时间明显在未来时失败关闭');
            assert.equal(fetcher.status().places.jinan.stale, true);
            now = fetchedAt;
            now = at('2026-11-03T14:30:00').getTime();
            await fetcher.refresh();
            fail = true;
            await fetcher.refresh();
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T14:30:00'))?.observedAt, '2026-11-03T14:00');
            assert.ok(logs.some(line => line.includes('没取到') && line.includes('timeout')));
            now = at('2026-11-03T17:30:00').getTime();
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T17:30:00')), undefined, '缓存过期不写进当前世界');
            assert.equal(JSON.parse(readFileSync(join(root, 'air-quality', 'jinan.json'), 'utf8')).since, '2026-11-03');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('进入世界提示词，但不改变原有天气和生活事件', () => {
        const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
        useRealAirQuality({ day: () => ({ pm25: 18, pm10: 32, aqi: 42, category: '优', observedAt: '2026-10-20T12:00:00', real: true }) });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-20T21:00:00'))!;
        assert.equal(now.airQuality?.aqi, 42);
        assert.match(describeWorld(now, at('2026-10-20T21:00:00'))!, /空气：AQI 42（优）/);
        assert.ok(now.weather, '天气仍然照旧存在');
    });

    test('结构损坏的缓存会隔离，不把错误 AQI 带进世界', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-air-quality-invalid-'));
        const dir = join(root, 'air-quality');
        mkdirSync(dir);
        writeFileSync(join(dir, 'jinan.json'), JSON.stringify({
            since: '2026-11-03', fetchedAt: '2026-11-03T03:30:00.000Z',
            hours: { '2026-11-03T03': { pm25: -1, pm10: 20, aqi: 30, o: 1 } },
        }));
        const logs: string[] = [];
        try {
            const fetcher = airQualityFetcher({ dir, log: message => logs.push(message), now: () => at('2026-11-03T03:30:00').getTime(), fetchJson: async () => ({}) });
            assert.equal(fetcher.day('jinan', '2026-11-03', at('2026-11-03T03:30:00')), undefined);
            assert.equal(existsSync(join(dir, 'jinan.json')), false);
            assert.ok(readdirSync(dir).some(name => name.startsWith('jinan.json.corrupt-')));
            assert.ok(logs.some(message => message.includes('空气质量缓存') && message.includes('挪到')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
