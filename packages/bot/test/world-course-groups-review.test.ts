import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { classesOn, type Schedule } from '../src/life/schedule.ts';
import { simulateWorld, worldAt, worldState, type World, type WorldAction } from '../src/world/world.ts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-course-groups-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const groupA = `cg-${'a'.repeat(32)}`; const groupB = `cg-${'b'.repeat(32)}`;
const at = (text: string) => new Date(`${text}+08:00`);
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' }, two: { start: '10:10', end: '11:40' } },
    semester: { start: '2026-11-02', weeks: 8 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    courses: [
        { day: 4, slot: 'one', weeks: '1-8', kind: 'hard', name: '合成课程甲', groupId: groupA },
        { day: 5, slot: 'one', weeks: '1-8', kind: 'hard', name: '合成课程甲', groupId: groupA },
        // 相同显示名也不能代替课程组身份；这一条是另一门课。
        { day: 1, slot: 'two', weeks: '1-8', kind: 'hard', name: '合成课程甲', groupId: groupB },
    ], free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成宿舍' };
const low: Schedule = { ...schedule, courses: schedule.courses.map(({ name: _name, ...course }) => course) };
const legacy: Schedule = { ...schedule, courses: schedule.courses.map(({ groupId: _group, ...course }) => course) };
const world: World = { startDay: '2026-11-05', awayHolidays: [], people: [], events: [],
    homework: { kinds: ['hard', 'machine'], chance: 1, earlyChance: 0, groupedFrom: '2026-11-05' } };
const until = at('2026-11-20T23:00:00');
const task = (w = world, s = schedule, day = '2026-11-05', id = 'course-1') => simulateWorld(w, s, until).homework.find(h => h.id === `${day}:${id}`)!;
const timing = (w: World, s: Schedule) => simulateWorld(w, s, until).homework.map(({ id, assigned, assignedAt, due, done }) => ({ id, assigned, assignedAt, due, done }));

test('完整课程组按下一日同组课程到期，高低披露档事实一致且同名异组不误并', () => {
    assert.equal(task().due.getTime(), at('2026-11-06T08:20:00').getTime());
    // 周五之后的下次同组是周四，而不是周一同显示名的另一组。
    assert.equal(task(world, schedule, '2026-11-06', 'course-2').due.getTime(), at('2026-11-12T08:20:00').getTime());
    assert.deepEqual(timing(world, low), timing(world, schedule));
    const [lesson] = classesOn(schedule, at('2026-11-05T00:00:00')).lessons;
    assert.equal(lesson!.groupId, groupA);
    assert.ok(!Object.keys(lesson!).includes('groupId'));
});

test('缺生效边界、旧无组和部分分组均保留完整旧规则，不由显示名猜测', () => {
    const noBoundary: World = { ...world, homework: { ...world.homework!, groupedFrom: undefined } };
    const partial: Schedule = { ...schedule, courses: schedule.courses.map((course, i) => i === 2 ? { ...course, groupId: undefined } : course) };
    assert.deepEqual(timing(noBoundary, schedule), timing(noBoundary, legacy));
    assert.deepEqual(timing(world, legacy), timing(noBoundary, legacy));
    assert.deepEqual(timing(world, partial), timing(noBoundary, legacy));
    assert.equal(task(noBoundary).due.getTime(), at('2026-11-12T08:20:00').getTime());
});

test('生效边界按布置日期确定，旧未完成作业在之后查询仍保留原到期和默认完成时刻', () => {
    const boundary: World = { ...world, homework: { ...world.homework!, groupedFrom: '2026-11-06' } };
    const old = task(boundary);
    assert.equal(old.due.getTime(), at('2026-11-12T08:20:00').getTime());
    assert.equal(old.done.getTime(), at('2026-11-11T22:00:00').getTime());
    const newTask = task(boundary, schedule, '2026-11-06', 'course-2');
    assert.equal(newTask.due.getTime(), at('2026-11-12T08:20:00').getTime());
    const earlyView = simulateWorld(boundary, schedule, at('2026-11-07T23:00:00')).homework.find(h => h.id === old.id)!;
    assert.deepEqual(earlyView, old);
    assert.deepEqual(timing(boundary, low), timing(boundary, schedule));
});

test('旧事件的作业目标和完成事实保持可回放，重启不迁移或改写既有事件', () => {
    const boundary: World = { ...world, homework: { ...world.homework!, groupedFrom: '2026-11-06' } };
    const before = task(boundary); const now = at('2026-11-10T20:10:00');
    const dir = fixture(); const state = worldState(boundary, schedule, () => {}, dir, () => now.getTime());
    state.recordEvents([{ id: 'old-success', kind: 'finish_homework', target: before.id,
        at: at('2026-11-10T20:00:00').toISOString(), source: 'external', result: 'succeeded' }]);
    assert.equal(state.events()[0]!.result, 'succeeded');
    assert.equal(state.events()[0]!.target, '2026-11-05:course-1');
    const recorded = structuredClone(state.events());
    const resumed = worldState(boundary, schedule, () => {}, dir, () => now.getTime());
    assert.deepEqual(resumed.events(), recorded);
    assert.equal(simulateWorld(boundary, schedule, now, resumed.actions()).homework.find(h => h.id === before.id)!.done.getTime(), at('2026-11-10T20:00:00').getTime());
    const high = resumed.at(boundary, schedule, now)!;
    const hidden = resumed.at(boundary, low, now)!;
    assert.deepEqual(high.homework.map(({ course: _course, ...h }) => h), hidden.homework.map(({ course: _course, ...h }) => h));
});

test('课程转实训不改变课程组，调休与假期以实际课表找下次同组课', () => {
    const practice: Schedule = { ...schedule, courses: schedule.courses.map((course, i) => i === 0 ? { ...course, practice: { fromWeek: 2 } } : course) };
    const [lesson] = classesOn(practice, at('2026-11-12T00:00:00')).lessons;
    assert.equal(lesson!.kind, 'machine');
    assert.equal(lesson!.groupId, groupA);
    assert.equal(task(world, practice, '2026-11-12').due.getTime(), at('2026-11-13T08:20:00').getTime());
    const makeup: Schedule = { ...schedule, makeups: [{ date: '2026-11-06', asDay: 0 }, { date: '2026-11-07', asDay: 5 }] };
    assert.equal(task(world, makeup).due.getTime(), at('2026-11-07T08:20:00').getTime());
    const holiday: Schedule = { ...schedule, holidays: [{ name: '合成假期', start: '2026-11-06', end: '2026-11-06' }] };
    assert.equal(task(world, holiday).due.getTime(), at('2026-11-12T08:20:00').getTime());
});

test('生效边界前的聊天回写目标不受新课程分组影响', () => {
    const boundary: World = { ...world, homework: { ...world.homework!, groupedFrom: '2026-11-06' } };
    const action: WorldAction = { id: 'conversation-old', kind: 'finish_homework', day: '2026-11-10', at: '2026-11-10T20:00',
        contact: 1, episode: 'ep-1', target: '2026-11-05:course-1' };
    const high = worldAt(boundary, schedule, at('2026-11-10T20:10:00'), [action])!;
    const hidden = worldAt(boundary, low, at('2026-11-10T20:10:00'), [action])!;
    assert.equal(high.homework.find(h => h.due.getTime() === at('2026-11-12T08:20:00').getTime())!.done, true);
    assert.deepEqual(high.homework.map(({ course: _course, ...h }) => h), hidden.homework.map(({ course: _course, ...h }) => h));
});
