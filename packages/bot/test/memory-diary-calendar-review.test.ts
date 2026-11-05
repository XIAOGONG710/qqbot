import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { diaryWriter } from '../src/life/diary.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';
import type { Schedule } from '../src/life/schedule.ts';

async function child(kind: string) {
    globalThis.fetch = async () => { throw new Error('Synthetic diary calendar forbids network'); };
    const root = mkdtempSync(join(tmpdir(), 'qqbot-diary-calendar-'));
    const dates: string[] = [], summaries: { id: string; last: string }[] = [], prompts: string[] = [], worldTimes: Date[] = [];
    const format = (day: Date) => `${String(day.getFullYear()).padStart(4, '0')}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:30' } }, semester: { start: '2011-09-01', weeks: 20 },
        holidays: kind === 'phase' ? [{ name: '合成假期', start: '2011-12-28', end: '2011-12-30' }] : [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    if (kind === 'week' || kind === 'phase') {
        const written: Record<string, number> = {}, texts: Record<string, string> = {};
        for (let day = kind === 'week' ? 26 : 28; day <= 31; day++) {
            const date = `2011-12-${day}`; written[date] = 20; texts[date] = day === 30 ? 'SKIPPED_LEGACY_DAY' : day === 31 ? 'OUTSIDE_PHASE_31' : `合成日记${day}`;
        }
        writeFileSync(join(root, 'diary.json'), JSON.stringify({ written, texts, weeks: {}, phases: {} }));
    }
    const memory = { derivedAvailable: () => true,
        retainDiary: async (date: string) => { dates.push(date); return true; },
        retainSummary: async (id: string, last: Date) => { summaries.push({ id, last: format(last) }); return true; }, readDiary: async () => undefined,
    } as unknown as LongTermMemory;
    const writer = diaryWriter({ sources: { charName: '合成角色', schedule, moods: [], books: [], ...(kind === 'late-gap' ? {
        world: { startDay: '2024-03-28', awayHolidays: [], people: [], events: [] }, resolveWorld: (_world, _schedule, at) => { worldTimes.push(at); return undefined; },
    } : {}) }, contacts: [], history: { load: () => [] }, memory,
        generate: async messages => { if (messages[0]!.content.includes('翻着自己')) prompts.push(messages[1]!.content); return '合成日记正文'; }, dir: root, log() {} });
    try {
        const now = kind === 'late-gap' ? '2024-03-31T12:00:00' : kind === 'week' ? '2012-01-02T12:00:00' : kind === 'spring' ? '2026-03-09T12:00:00' : kind === 'fall' ? '2026-11-02T12:00:00' : kind === 'low' ? '0000-01-03T12:00:00' : '2011-12-31T12:00:00';
        await writer.catchUp(new Date(now));
        if (kind === 'daily') assert.deepEqual(dates, ['2011-12-28', '2011-12-29']);
        if (kind === 'week') {
            const text = prompts.find(prompt => prompt.includes('合成日记26'))!; assert.ok(text);
            assert.equal((text.match(/\[12月31日/g) ?? []).length, 1); assert.ok(!text.includes('SKIPPED_LEGACY_DAY'));
            assert.equal(JSON.parse(readFileSync(join(root, 'diary.json'), 'utf8')).texts['2011-12-30'], 'SKIPPED_LEGACY_DAY');
        }
        if (kind === 'phase') {
            const phase = summaries.find(item => item.id === 'phase:合成假期:2011-12-30'); assert.ok(phase); assert.equal(phase.last, '2011-12-29');
            assert.ok(prompts.every(prompt => !prompt.includes('OUTSIDE_PHASE_31')));
        }
        if (kind === 'spring') assert.deepEqual(dates, ['2026-03-06', '2026-03-07', '2026-03-08']);
        if (kind === 'fall') assert.deepEqual(dates, ['2026-10-30', '2026-10-31', '2026-11-01']);
        if (kind === 'low') assert.deepEqual(dates, ['0000-01-01', '0000-01-02']);
        if (kind === 'late-gap') { assert.equal(worldTimes.length, 3); assert.ok(worldTimes.every(at => format(at) < '2024-03-31'), '23点缺时不能把当天日记世界材料推到次日'); }
        assert.equal(new Set(dates).size, dates.length); assert.ok(dates.every(date => date < now.slice(0, 10)));
    } finally {
        await writer.stop(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-diary-calendar-')); rmSync(root, { recursive: true, force: true });
    }
}

if (process.env.SYNTHETIC_DIARY_CALENDAR_CHILD) await child(process.env.SYNTHETIC_DIARY_CALENDAR_CHILD);
else {
    for (const [kind, zone] of [['daily', 'Pacific/Apia'], ['week', 'Pacific/Apia'], ['phase', 'Pacific/Apia'], ['spring', 'America/New_York'], ['fall', 'America/New_York'], ['low', 'UTC'], ['late-gap', 'America/Nuuk']] as const) {
        test(`日记民用日期 ${kind} ${zone}`, () => {
            const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: zone, SYNTHETIC_DIARY_CALENDAR_CHILD: kind }, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
            assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr || result.stdout);
        });
    }
}
