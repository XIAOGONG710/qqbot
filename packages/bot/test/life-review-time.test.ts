import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanValuesAt, type HumanValueFacts } from '../src/human-values.ts';
import { projectPortfolio } from '../src/life/projects.ts';
import { bookProgressOn, parseBooks, type ReadingBook } from '../src/life/her-days.ts';
import { pursuitViews, quizRecord, type Pursuit } from '../src/life/pursuits.ts';
import { quizzesOn, quizEvents } from '../src/life/everyday.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';
import type { LifeEvent } from '../src/world/life-events.ts';

const now = new Date('2026-11-05T12:00:00+08:00');
const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' }, two: { start: '10:10', end: '11:40' } },
    semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    courses: [1, 2, 3, 4, 5].map(day => ({ day, slot: 'one', weeks: '1-20', kind: 'hard', name: '高等数学' })),
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
};
const event: LifeEvent = { id: 'future', actor: 'linmengyao', kind: 'work_on_project', target: 'photography_growth', subject: '修片', day: '2026-11-06',
    startedAt: '2026-11-06T12:00:00+08:00', endedAt: '2026-11-06T13:00:00+08:00', source: 'simulation', result: 'succeeded' };

test('未来消息及未来行动不改变今天的真人状态或项目组合，结束时才计入', () => {
    const facts: HumanValueFacts = { at: now, needs: { at: now.toISOString(), energy: 68, hunger: 35, stress: 24 }, history: [], tier: 'boyfriend' };
    const baseline = humanValuesAt(facts);
    assert.deepEqual(humanValuesAt({ ...facts, history: [{ role: 'user', content: '未来消息', time: event.endedAt }] }), baseline);
    assert.deepEqual(humanValuesAt({ ...facts, events: [event] }), baseline);
    const input = { now, schedule, books: [], events: [] as LifeEvent[] };
    assert.deepEqual(projectPortfolio({ ...input, events: [event] }), projectPortfolio(input));
    const atEnd = new Date(event.endedAt);
    assert.notDeepEqual(projectPortfolio({ ...input, now: atEnd, events: [event] }), projectPortfolio({ ...input, now: atEnd }));
});

const book: ReadingBook = { id: 'test', title: '合成书', aliases: [], author: '测试', kind: '小说', platform: '测试', status: '完结',
    total: { amount: 10, unit: '章' }, progress: { startDay: '2026-11-01', start: 1, everyDays: 1, amount: 5, unit: '章', state: 'reading' },
    attitude: '喜欢', unreadKeywords: [], nodes: [] };
test('可靠阅读总量封顶，完成后不继续增长；没有总量仍遵守原来的 max', () => {
    for (const day of [now, new Date('2027-11-05T12:00:00+08:00')]) assert.deepEqual(bookProgressOn(book, day), { amount: 10, unit: '章', finished: true, stopped: true });
    assert.equal(bookProgressOn({ ...book, total: undefined, progress: { ...book.progress, max: 8 } }, now).amount, 8);
    assert.equal(bookProgressOn({ ...book, progress: { ...book.progress, max: 6 } }, now).finished, false);
    assert.throws(() => parseBooks([{ ...book, progress: { ...book.progress, start: 11 } }], '合成资料'));
});

test('自定义追求在完成时刻之前保持未完成，评价也不泄漏未来完成事实', () => {
    const pursuit: Pursuit = { id: 'custom', title: '画画', why: '练习', status: 'active', steps: [{ text: '起稿', doneAt: event.endedAt }] };
    const before = pursuitViews([pursuit], { now, schedule, quizzes: false })[0]!;
    assert.match(before.text, /现在在第 1 步/);
    assert.deepEqual(before.appraisals, []);
    const after = pursuitViews([pursuit], { now: new Date(event.endedAt), schedule, quizzes: false })[0]!;
    assert.match(after.text, /这几步都做完了/);
    assert.equal(after.appraisals.length, 1);
});

test('成绩记录和世界事件使用完全相同的出分时刻', () => {
    let checked = 0;
    for (let i = 0; i < 140; i++) {
        const day = new Date(2026, 8, 7 + i);
        if (!quizzesOn(schedule, day).length) continue;
        const releaseDay = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2);
        const release = quizEvents(schedule, releaseDay, true).find(e => e.id.startsWith('quiz_score:'))!;
        const found = (at: Date) => quizRecord(schedule, at).filter(q => q.date === formatDate(day));
        assert.deepEqual(found(new Date(release.at.getTime() - 1)), []);
        assert.equal(found(release.at).length, 1);
        assert.equal(found(new Date(release.at.getTime() + 1)).length, 1);
        checked++;
    }
    assert.ok(checked > 3);
});

test('同日多节同名课仅首次生成周测，事件 ID 唯一，课表输入顺序不影响结果', () => {
    const twice: Schedule = { ...schedule, courses: [
        { day: 1, slot: 'two', weeks: '1-20', kind: 'hard', name: '高等数学' },
        { day: 1, slot: 'one', weeks: '1-20', kind: 'hard', name: '高等数学' },
    ] };
    let checked = 0;
    for (let i = 0; i < 20; i++) {
        const day = new Date(2026, 8, 7 + i * 7);
        const quizzes = quizzesOn(twice, day);
        if (!quizzes.length) continue;
        assert.equal(quizzes.length, 1);
        assert.equal(quizzes[0]!.lesson.start.getHours(), 8);
        const events = quizEvents(twice, day, true);
        assert.equal(new Set(events.map(e => e.id)).size, events.length);
        checked++;
    }
    assert.ok(checked > 0);
});
