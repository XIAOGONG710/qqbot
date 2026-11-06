import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { calendarFetcher, parseHolidayApi, useRealCalendar } from '../src/world/calendar.ts';
import { describeWorld, summarizeWorld, worldAt } from '../src/world/world.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const at = (iso: string) => new Date(`${iso}+08:00`);
const payload = (year = 2026) => ({ holiday: {
    '01-01': { holiday: true, name: '元旦节', date: `${year}-01-01` },
    '01-04': { holiday: false, name: '元旦节（班）', date: `${year}-01-04` },
} });

afterEach(() => useRealCalendar(undefined));

describe('现实法定日历（ADR 0231）', () => {
    test('识别休假和调休上班，拒绝坏日期', () => {
        assert.deepEqual(parseHolidayApi(payload(), 2026), {
            '2026-01-01': { date: '2026-01-01', name: '元旦节', kind: 'holiday', real: true },
            '2026-01-04': { date: '2026-01-04', name: '元旦节（班）', kind: 'workday', real: true },
        });
        assert.throws(() => parseHolidayApi({ holiday: { '01-01': { holiday: true, name: '', date: '2026-01-01' } } }, 2026), /有效/);
        assert.throws(() => parseHolidayApi({ holiday: { '01-01': { holiday: true, name: '元旦节', date: '2025-01-01' } } }, 2026), /有效/);
        assert.throws(() => parseHolidayApi({ holiday: { '02-30': { holiday: true, name: '不存在的节日', date: '2026-02-30' } } }, 2026), /有效/);
    });

    test('缓存成功读取，失败保留旧值，过期不进入世界', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-calendar-'));
        let now = at('2026-11-03T12:00').getTime();
        let fail = false;
        const logs: string[] = [];
        const fetcher = calendarFetcher({
            dir: join(root, 'calendar'), now: () => now, log: message => logs.push(message), cacheMaxAgeMs: 7 * 86_400_000,
            years: () => [2026], fetchJson: async () => { if (fail) throw new Error('timeout'); return payload(); },
        });
        try {
            await fetcher.refresh();
            assert.equal(fetcher.day('2026-01-01')?.kind, 'holiday');
            assert.equal(fetcher.day('2026-01-04')?.kind, 'workday');
            const fetchedAt = now;
            now -= 120_000;
            assert.equal(fetcher.day('2026-01-04'), undefined, '缓存时间明显在未来时失败关闭');
            assert.deepEqual(fetcher.status().staleYears, [2026]);
            now = fetchedAt;
            fail = true;
            await fetcher.refresh();
            assert.equal(fetcher.day('2026-01-04')?.kind, 'workday');
            assert.ok(logs.some(line => line.includes('没取到') && line.includes('timeout')));
            now += 8 * 86_400_000;
            assert.equal(fetcher.day('2026-01-04'), undefined);
            assert.equal(fetcher.status().stale, true);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('部分年份刷新成功时，不给失败年份的旧缓存续期', async () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-calendar-years-'));
        let now = at('2026-11-03T12:00').getTime();
        let failYear: number | undefined;
        const fetcher = calendarFetcher({
            dir: join(root, 'calendar'), now: () => now, log: () => {}, cacheMaxAgeMs: 7 * 86_400_000,
            years: () => [2026, 2027],
            fetchJson: async url => {
                const year = Number(url.split('/').at(-1));
                if (year === failYear) throw new Error('timeout');
                return payload(year);
            },
        });
        try {
            await fetcher.refresh();
            assert.equal(fetcher.day('2027-01-01')?.kind, 'holiday');
            now += 8 * 86_400_000;
            failYear = 2027;
            await fetcher.refresh();
            assert.equal(fetcher.day('2026-01-01')?.kind, 'holiday');
            assert.equal(fetcher.day('2027-01-01'), undefined);
            assert.deepEqual(fetcher.status().staleYears, [2027]);
            assert.match(fetcher.status().error ?? '', /2027 年/);
            failYear = 2026;
            await fetcher.refresh();
            assert.match(fetcher.status().error ?? '', /2026 年/, '后一个年份成功也不能清掉前一个年份的失败');
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('进入世界，但不改学校课表', () => {
        const card = loadCharacterCard(syntheticCardPath('boyfriend'));
        useRealCalendar({ day: date => date === '2026-10-10' ? { date, name: '国庆节（班）', kind: 'workday', real: true } : undefined });
        const now = worldAt(card.herWorld!, card.schedule!, at('2026-10-10T14:00'))!;
        assert.equal(now.publicHoliday?.kind, 'workday');
        assert.equal(now.publicHoliday?.name, '国庆节（班）');
        assert.match(describeWorld(now, at('2026-10-10T14:00'))!, /法定日历：国庆节（班）（调休上班）/);
        assert.match(summarizeWorld(now), /法定日历 班/);
        assert.equal(now.atSchool, true, '全国调休不能代替学校自己的课表');
    });

    test('结构损坏的法定日历缓存会隔离，不把伪造假期带进世界', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-calendar-invalid-'));
        const dir = join(root, 'calendar');
        mkdirSync(dir);
        writeFileSync(join(dir, 'calendar.json'), JSON.stringify({
            fetchedAt: '2026-11-03T12:00:00.000Z', yearFetchedAt: { 2026: '2026-11-03T12:00:00.000Z' },
            years: { 2026: { '2026-02-30': { date: '2026-02-30', name: '不存在的假期', kind: 'holiday', real: true } } },
        }));
        const logs: string[] = [];
        try {
            const fetcher = calendarFetcher({ dir, log: message => logs.push(message), now: () => at('2026-11-03T12:00').getTime(), years: () => [2026], fetchJson: async () => ({}) });
            assert.equal(fetcher.day('2026-02-30'), undefined);
            assert.equal(existsSync(join(dir, 'calendar.json')), false);
            assert.ok(readdirSync(dir).some(name => name.startsWith('calendar.json.corrupt-')));
            assert.ok(logs.some(message => message.includes('法定日历缓存') && message.includes('挪到')));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
