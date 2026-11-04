import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classesOn, parseSchedule, type Schedule } from '../src/life/schedule.ts';
const group = 'cg-0123456789abcdef0123456789abcdef';
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 },
    holidays: [], makeups: [], courses: [{ day: 4, slot: 'one', weeks: '1-20', kind: 'hard', name: '合成课程', groupId: group }],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };

test('匿名组在课表解析及JSON往返中保留，生成课程实例只以非枚举元数据携带', () => {
    const parsed = parseSchedule(schedule, '合成资料');
    assert.equal(parsed.courses[0]!.groupId, group);
    const roundTrip = parseSchedule(JSON.parse(JSON.stringify(parsed)), '合成资料');
    const [lesson] = classesOn(roundTrip, new Date('2026-11-05T12:00:00+08:00')).lessons;
    assert.equal(lesson!.id, 'course-1');
    assert.equal(lesson!.groupId, group);
    assert.equal(JSON.stringify(lesson).includes(group), false);
    assert.equal(Object.keys(lesson!).includes('groupId'), false);
});

test('高低披露档沿用同一匿名组和课表条目ID，去除课名不改变身份', () => {
    const hidden = { ...schedule, courses: schedule.courses.map(({ name, ...course }) => course) };
    const day = new Date('2026-11-05T12:00:00+08:00');
    const high = classesOn(parseSchedule(schedule, '高档'), day).lessons[0]!;
    const low = classesOn(parseSchedule(hidden, '低档'), day).lessons[0]!;
    assert.equal(low.name, undefined);
    assert.equal(high.groupId, low.groupId);
    assert.equal(high.id, low.id);
});

test('旧无分组课表保持原实例身份；不允许课名或任意对象冒充匿名组', () => {
    const old = { ...schedule, courses: schedule.courses.map(({ groupId, ...course }) => course) };
    const [lesson] = classesOn(parseSchedule(old, '旧资料'), new Date('2026-11-05T12:00:00+08:00')).lessons;
    assert.equal(lesson!.id, 'course-1');
    assert.equal(lesson!.groupId, undefined);
    for (const groupId of ['合成私密课程标记', 'cg-short', null, 1, {}]) assert.throws(() => parseSchedule({ ...schedule, courses: [{ ...schedule.courses[0], groupId }] }, '合成资料'), error => error instanceof Error && error.message.includes('groupId') && !error.message.includes(String(groupId)));
});
