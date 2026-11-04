import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { scheduleForTier } from '../src/schedule-to-card.ts';
import { checkSource, readSource, type ScheduleSource } from '../src/source.ts';
import { checkWorld, worldForTier } from '../src/world-source.ts';

const firstGroup = `cg-${'1'.repeat(32)}`;
const secondGroup = `cg-${'2'.repeat(32)}`;
const source = readSource(resolve(import.meta.dirname, '../../../characters/linmengyao/source'));
const synthetic: ScheduleSource = {
    sleep: '02:00', wakeup: { early: '07:40', lazy: '09:30' }, periods: { one: '08:20-09:50' }, semester: { start: '2026-09-07', weeks: 20 },
    holidays: [], makeups: [],
    courses: [
        { name: '合成私密课程甲', day: 1, slot: 'one', room: '合成教室', kind: 'hard', weeks: '1-20', course_group: firstGroup },
        { name: '合成私密课程甲', day: 3, slot: 'one', room: '合成教室', kind: 'hard', weeks: '1-20', course_group: firstGroup },
        { name: '合成私密课程乙', day: 5, slot: 'one', room: '合成教室', kind: 'hard', weeks: '1-20', course_group: secondGroup },
    ],
    free: [{ window: 'morning', text: '休息' }, { window: 'afternoon', text: '休息' }, { window: 'evening', text: '休息' }],
    course_detail: { tiers: ['detail'] }, kinds: { hard: { label: '课' }, machine: { label: '课' }, water: { label: '课' }, pe: { label: '课' } },
    where: { by_tier: [{ tiers: ['detail', 'anonymous'], text: '校园' }] },
};

test('匿名课程身份跨披露档一致；低披露档不因身份字段泄漏课名或教室', () => {
    const detailed = scheduleForTier(synthetic, 'detail');
    const anonymous = scheduleForTier(synthetic, 'anonymous');
    assert.deepEqual(detailed.courses.map(course => course.groupId), [firstGroup, firstGroup, secondGroup]);
    assert.deepEqual(anonymous.courses.map(course => course.groupId), detailed.courses.map(course => course.groupId));
    assert.ok(anonymous.courses.every(course => course.name === undefined && course.room === undefined));
    assert.ok(!JSON.stringify(anonymous).includes('合成私密课程'));
    assert.ok(!JSON.stringify(anonymous).includes('合成教室'));
});

test('课程身份来自持久令牌，改名或重排不会重新按名字或数组序号生成', () => {
    const changed = structuredClone(synthetic);
    changed.courses.forEach(course => { course.name = '改过的合成课程名'; });
    changed.courses.reverse();
    assert.deepEqual(scheduleForTier(changed, 'anonymous').courses.map(course => course.groupId), [secondGroup, firstGroup, firstGroup]);
});

test('课程源接受严格匿名令牌，拒绝错误格式且错误不回显内容', () => {
    const valid = structuredClone(source);
    valid.schedule.courses[0]!.course_group = firstGroup;
    assert.equal(checkSource(valid).schedule.courses[0]!.course_group, firstGroup);
    for (const token of ['合成私密课名', 'cg-short', `cg-${'A'.repeat(32)}`, 'a'.repeat(64)]) {
        const bad = structuredClone(valid);
        bad.schedule.courses[0]!.course_group = token;
        assert.throws(() => checkSource(bad), error => error instanceof Error && error.message.includes('course_group') && !error.message.includes(token));
    }
});

test('作业分组生效日必须是真实日历日期，不能让溢出日期自动滚动', () => {
    assert.ok(source.world);
    const valid = structuredClone(source.world);
    valid.homework.grouped_from = '2024-02-29';
    assert.equal(checkWorld(valid).homework.grouped_from, '2024-02-29');
    for (const value of ['2026-02-30', '2025-02-29', '2026-13-01', 'bad']) {
        const bad = structuredClone(valid);
        bad.homework.grouped_from = value;
        assert.throws(() => checkWorld(bad), /grouped_from/);
    }
});

test('作业生效日随可见作业规则写进各档卡，保留既有规则数值', () => {
    assert.ok(source.world);
    const world = structuredClone(source.world);
    world.homework.grouped_from = '2026-11-05';
    for (const tier of source.tiers.tiers) {
        const result = worldForTier(world, tier.name);
        if (!world.homework.tiers.includes(tier.name)) { assert.equal(result?.homework, undefined); continue; }
        assert.equal(result?.homework?.groupedFrom, '2026-11-05');
        assert.equal(result?.homework?.chance, world.homework.chance);
        assert.equal(result?.homework?.earlyChance, world.homework.early_chance);
    }
});

test('旧无分组源仍不生成新字段，避免隐式启用或更改历史规则', () => {
    const legacy = structuredClone(synthetic);
    legacy.courses.forEach(course => { delete course.course_group; });
    assert.ok(scheduleForTier(legacy, 'detail').courses.every(course => !Object.hasOwn(course, 'groupId')));
    assert.ok(source.world);
    const world = structuredClone(source.world);
    delete world.homework.grouped_from;
    for (const tier of world.homework.tiers) assert.ok(!Object.hasOwn(worldForTier(world, tier)!.homework!, 'groupedFrom'));
});
