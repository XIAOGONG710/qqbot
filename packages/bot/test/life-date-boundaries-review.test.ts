import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classesOn, formatDate, herDay, parseSchedule, stateAt, wakeOn, type Schedule } from '../src/life/schedule.ts';
import { nextPayday, lastPayday, type Money } from '../src/life/money.ts';
import { bodyAt } from '../src/life/body.ts';
import { bookProgressOn, type ReadingBook } from '../src/life/her-days.ts';
import { dishOn, loadMenuFrom } from '../src/life/menu.ts';
import { loadEverydayFrom, quizzesOn, quizReleaseAt } from '../src/life/everyday.ts';
import { nightOf } from '../src/life/bedtime.ts';
import { askedWindow } from '../src/life/people.ts';
import { meetWindow, forgotten, type HerPromise } from '../src/life/promises.ts';
import { loopForgotten } from '../src/life/open-loops.ts';
import { judgeAction } from '../src/life/actions.ts';
import { dayPlan } from '../src/life/day-plan.ts';
import { diaryWriter } from '../src/life/diary.ts';
import type { LongTermMemory } from '../src/memory/long-term.ts';

const date = (day: string, time = '12:00:00') => new Date(`${day}T${time}`);
const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: '1' },
    periods: { '1': { start: '08:20', end: '09:50' } }, semester: { start: '0000-02-28', weeks: 20 },
    holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    courses: [{ day: date('0000-02-29').getDay() || 7, slot: '1', weeks: '1-20', kind: 'hard' }],
    free: { morning: ['合成上午'], afternoon: ['合成下午'], evening: ['合成晚上'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点',
};

test('日历年 0000..9999 固定四位，越界年份不伪装成合法日期', () => {
    for (const year of ['0000', '0001', '0099', '0100', '1900', '2026', '9999']) assert.equal(formatDate(date(`${year}-02-28`)), `${year}-02-28`);
    for (const year of [-1, 10000]) {
        const at = date('2026-02-28'); at.setFullYear(year);
        assert.equal(/^\d{4}-\d{2}-\d{2}$/.test(formatDate(at)), false);
    }
});

test('零年闰日的课表、她的一天和起床不跳到 1900 年', () => {
    assert.equal(formatDate(herDay(schedule, date('0000-02-29', '01:00:00'))), '0000-02-28');
    const lesson = classesOn(schedule, date('0000-02-29')).lessons[0];
    assert.ok(lesson); assert.equal(lesson.start.getFullYear(), 0); assert.equal(lesson.start.getHours(), 8);
    assert.equal(wakeOn(schedule, date('0000-02-29')).getFullYear(), 0);
    assert.equal(stateAt(schedule, date('0000-02-29', '09:00:00')).activity.kind, 'class');
});

test('跨低年世纪的生活费仍按相邻日历月结算', () => {
    const money = { payday: 1 } as Money;
    assert.equal(formatDate(nextPayday(money, date('0099-12-31'))), '0100-01-01');
    assert.equal(formatDate(lastPayday(money, date('0099-12-31'))), '0099-12-01');
});

test('零年闰日的身体和读书进度计入真实日历日', () => {
    assert.equal(bodyAt({ period: { first: '0000-02-28', cycle: [28, 28], days: 5, crampsChance: 1, detail: true } }, schedule, date('0000-02-29')).period?.day, 2);
    const book = { progress: { startDay: '0000-02-28', start: 1, everyDays: 1, amount: 1, unit: '章', state: 'reading' } } as ReadingBook;
    assert.equal(bookProgressOn(book, date('0000-03-01')).amount, 3);
});

test('菜单把零年闰日和次日作为不同天，新启用日期保留闰日', () => {
    const menu = { lunch: ['合成甲', '合成乙', '合成丙'], dinner: ['合成甲', '合成乙', '合成丙'] };
    assert.notEqual(dishOn('0000-02-29', 'lunch', menu), dishOn('0000-03-01', 'lunch', menu));
    const dir = mkdtempSync(join(tmpdir(), 'life-calendar-'));
    try { assert.equal(loadMenuFrom(join(dir, 'from.json'), date('0000-02-28')), '0000-02-29'); }
    finally { rmSync(dir, { recursive: true, force: true }); }
});

test('成绩、睡眠、约定与回忆窗口共用低年份日历', () => {
    assert.equal(formatDate(quizReleaseAt('合成课程', date('0000-02-28'))), '0000-03-01');
    const night = nightOf(schedule, date('0000-02-28', '23:00:00'));
    assert.ok(night); assert.equal(formatDate(night.bed), '0000-02-29');
    const promise = { id: 'synthetic', what: '合成约定', said: '0000-02-20', episode: 'synthetic', date: '0000-02-29', meet: { time: '18:00', minutes: 60 } } as HerPromise;
    assert.equal(formatDate(meetWindow(promise)!.start), '0000-02-29');
    assert.equal(forgotten({ ...promise, date: undefined }, date('0000-03-01')), true);
    assert.equal(loopForgotten({ id: 'synthetic', kind: 'unanswered', what: '合成事项', said: '0000-02-20', episode: 'synthetic' }, date('0000-03-01')), true);
    const window = askedWindow([{ role: 'user', content: '昨天做什么' }], date('0000-03-01'), schedule);
    assert.ok(window); assert.equal(formatDate(window.start), '0000-02-29'); assert.equal(formatDate(window.end), '0000-03-01');
});

test('行动拒绝跨出四位日历范围的成功结果', () => {
    const context = { schedule: { ...schedule, semester: { start: '9999-12-01', weeks: 1 }, courses: [] } };
    const verdict = judgeAction({ id: 'synthetic', kind: 'study', startedAt: date('9999-12-31', '23:50:00'), durationMinutes: 60 }, context);
    assert.equal(verdict.ok, false); if (!verdict.ok) assert.equal(verdict.reason, 'invalid_time');
    const fixed = judgeAction({ id: 'synthetic', kind: 'meet', startedAt: date('9999-12-31', '23:50:00') }, {
        ...context, appointments: [{ id: 'synthetic', start: date('9999-12-31', '23:50:00'), end: new Date('+010000-01-01T00:50:00'), subject: '合成约定', target: 'synthetic', meal: false }],
    });
    assert.equal(fixed.ok, false); if (!fixed.ok) assert.equal(fixed.reason, 'invalid_time');
    const beforeFirstDay = judgeAction({ id: 'synthetic', kind: 'study', startedAt: date('0000-01-01', '01:00:00'), durationMinutes: 25 }, { schedule });
    assert.equal(beforeFirstDay.ok, false); if (!beforeFirstDay.ok) assert.equal(beforeFirstDay.reason, 'invalid_time');
});

test('日程小测保持 400 年同周历一致，低年计划选到真实事项', () => {
    const count = (year: string) => {
        const start = `${year}-01-03`;
        const fixture = { ...schedule, semester: { start, weeks: 20 }, courses: [{ day: 1, slot: '1', weeks: '1-20', kind: 'hard' as const, name: '合成高等数学', quiz: 'math' as const }] };
        return Array.from({ length: 20 }, (_, i) => {
            const at = date(start); at.setDate(at.getDate() + 7 * i); return quizzesOn(fixture, at).length;
        });
    };
    assert.deepEqual(count('0000'), count('0400')); assert.ok(count('0000').some(Boolean));
    assert.ok(dayPlan(schedule, undefined, date('0000-03-01'), { errands: [{ start: date('0000-03-01', '15:00:00'), text: '合成事项' }] })
        .some(slot => slot.window === 'afternoon' && slot.done === '15:00 合成事项'));
});

test('低年日记回填包含闰日，支持起点不写负年日记或周键', async () => {
    for (const [now, expected] of [
        ['0000-03-01', ['0000-02-27', '0000-02-28', '0000-02-29']],
        ['0000-01-02', ['0000-01-01']],
    ] as const) {
        const dir = mkdtempSync(join(tmpdir(), 'life-diary-calendar-')); const retained: string[] = [];
        const memory = { retainDiary: async (at: string) => { retained.push(at); return true; }, retainSummary: async () => true, readDiary: async () => undefined } as unknown as LongTermMemory;
        const writer = diaryWriter({ dir, sources: { charName: '合成角色', schedule, moods: [], books: [] }, contacts: [], history: { load: () => [] }, memory, generate: async () => '合成日记', log: () => undefined });
        try {
            await writer.catchUp(date(now)); assert.deepEqual(retained, expected);
            const state = JSON.parse(readFileSync(join(dir, 'diary.json'), 'utf8'));
            assert.ok(Object.keys(state.weeks).every(key => /^\d{4}-\d{2}-\d{2}$/.test(key)));
            await writer.catchUp(date(now)); assert.deepEqual(retained, expected, '重启式重复读取不生成重复日记');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    }
});

test('启用边界无次日可用时明确失败并保持文件不存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'life-from-boundary-'));
    try {
        for (const [index, load] of [loadMenuFrom, loadEverydayFrom].entries()) {
            const path = join(dir, `${index}.json`);
            assert.throws(() => load(path, date('9999-12-31')), error => error instanceof RangeError && !error.message.includes('10000'));
            assert.equal(existsSync(path), false);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('所有课表日期入口拒绝滚动日期和正文，接受低年真实闰日', () => {
    const fixtures = (value: string): Schedule[] => [
        { ...schedule, semester: { start: value, weeks: 20 } },
        { ...schedule, holidays: [{ name: '合成假期', start: value, end: '2026-03-10' }] },
        { ...schedule, holidays: [{ name: '合成假期', start: '2026-02-01', end: value }] },
        { ...schedule, makeups: [{ date: value, asDay: 1 }] },
        { ...schedule, wake: { ...schedule.wake, jitter: { from: value, spreadMin: 1, weekendMin: 1 } } },
        { ...schedule, free: { ...schedule.free, on: [{ date: value, window: 'morning', text: '合成活动' }] } },
        { ...schedule, free: { ...schedule.free, later: [{ from: value, window: 'morning', text: '合成活动' }] } },
        { ...schedule, free: { ...schedule.free, later: [{ from: '0000-01-01', until: value, window: 'morning', text: '合成活动' }] } },
    ];
    for (const bad of ['2026-02-30', '0099-02-29', '10000-01-01', 'PRIVATE_CALENDAR_VALUE']) {
        for (const fixture of fixtures(bad)) assert.throws(() => parseSchedule(fixture, 'synthetic'), error => error instanceof Error && !error.message.includes(bad));
    }
    for (const good of ['0000-02-29', '0096-02-29', '0100-02-28', '2026-03-01', '9999-12-31']) {
        for (const fixture of fixtures(good)) assert.doesNotThrow(() => parseSchedule(fixture, 'synthetic'));
    }
});
