import assert from 'node:assert/strict';
import { test } from 'node:test';
import { npcStates, type NpcLife } from '../src/world/npc.ts';
import { obstaclesBetween, describeObstacles } from '../src/world/obstacles.ts';
import { parseWorld, worldAt, type World, type WorldNow } from '../src/world/world.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { coordinateNpcDates, DEFAULT_ASKS, npcAsksOn, type NpcDateReservation } from '../src/world/npc-asks.ts';

const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' }, periods: { one: { start: '08:20', end: '09:50' } },
    semester: { start: '2026-09-07', weeks: 200 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    courses: [1, 2, 3, 4, 5].map(day => ({ day, slot: 'one', weeks: '1-200', kind: 'hard', name: '合成课程' })),
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成宿舍',
};
const day = new Date('2026-11-05T00:00:00+08:00');

test('NPC日子拒绝非有限或失控的月次数、非法持续范围与空标签', () => {
    const invalid: unknown[] = [
        { sick: { perMonth: -1, days: [2, 4] } }, { sick: { perMonth: Infinity, days: [2, 4] } },
        { sick: { perMonth: 1e9, days: [2, 4] } }, { sick: { perMonth: NaN, days: [2, 4] } },
        { sick: { perMonth: 1, days: [4, 2] } }, { sick: { perMonth: 1, days: [0, 2] } },
        { sick: { perMonth: 1, days: [2, 15] } }, { busy: { perMonth: 1, days: [2, 3], labels: [] } },
        { busy: { perMonth: 1, days: [2, 3], labels: [''] } }, { home: { weekendChance: 2, holidays: true } },
        { home: { weekendChance: 0.5, holidays: 'false' } },
    ];
    for (const life of invalid) assert.throws(() => npcStates('synthetic', life as NpcLife, schedule, day), RangeError);
    assert.deepEqual(npcStates('synthetic', { sick: { perMonth: 0, days: [1, 14] } }, schedule, day), []);
    assert.throws(() => npcStates('synthetic', undefined, schedule, new Date(NaN)), RangeError);
});

test('角色世界解析拒绝无界NPC配置，而不是等进入日程计算后才挂住', () => {
    const value = { startDay: '2026-09-07', awayHolidays: [], events: [],
        people: [{ id: 'synthetic', name: '合成NPC', relation: '朋友', life: { sick: { perMonth: Infinity, days: [2, 4] } } }] };
    assert.throws(() => parseWorld(value, '合成资料'), /people.*life/);
});

test('公开的自定义NPC邀请配置也拒绝无界或负数月次数', () => {
    for (const perMonth of [-1, Infinity, 1e9, NaN]) {
        const config = { ...DEFAULT_ASKS.chen_jianing!, perMonth };
        assert.throws(() => npcAsksOn([{ id: 'synthetic', name: '合成NPC' }], schedule, day, { synthetic: config }), RangeError);
    }
});

const at = (time: string) => new Date(`2026-11-05T${time}:00+08:00`);
const date = (id: string, asked: string, start: string, patch: Partial<NpcDateReservation> = {}): NpcDateReservation =>
    ({ id, askedAt: at(asked), start: at(start), minutes: 60, outcome: 'on_time', held: true, ...patch });

test('协调优先保护先答应的约，同刻稳定ID打平，不修改输入', () => {
    const earlier = date('z-earlier', '08:00', '19:00');
    const later = date('a-later', '09:00', '19:30');
    const before = JSON.stringify([earlier, later]);
    const result = coordinateNpcDates([later, earlier]);
    assert.equal(result.find(d => d.id === earlier.id)!.held, true);
    const refused = result.find(d => d.id === later.id)!;
    assert.equal(refused.held, false);
    assert.equal(refused.declinedAt?.getTime(), later.askedAt.getTime());
    assert.match(refused.declined!, /已经答应/);
    assert.equal(JSON.stringify([earlier, later]), before);
    assert.deepEqual(coordinateNpcDates([earlier, later]), result);
    const tied = coordinateNpcDates([date('b', '08:00', '19:00'), date('a', '08:00', '19:30')]);
    assert.equal(tied.find(d => d.id === 'a')!.held, true);
    assert.equal(tied.find(d => d.id === 'b')!.held, false);
});

test('取消在被告知之后才释放，之前拒绝的邀请不会因后来取消而自动复活', () => {
    const cancelled = date('cancelled', '08:00', '19:00', { outcome: 'cancelled', knownAt: at('18:00'), held: false });
    const beforeNotice = date('before', '17:00', '19:00');
    const afterNotice = date('after', '18:00', '19:00');
    const result = coordinateNpcDates([afterNotice, beforeNotice, cancelled]);
    assert.equal(result.find(d => d.id === 'before')!.held, false);
    assert.equal(result.find(d => d.id === 'before')!.declinedAt?.getTime(), at('17:00').getTime());
    assert.equal(result.find(d => d.id === 'after')!.held, true);
});

test('改约和迟到撞上其他已有承诺时，记录得知变化时的拒绝，不提前泄漏', () => {
    for (const outcome of ['moved', 'late'] as const) {
        const knownAt = at(outcome === 'late' ? '19:00' : '18:00');
        const changing = date('changing', '08:00', '19:00', { outcome, actualStart: at('19:30'), knownAt });
        const other = date('other', '09:00', '20:00');
        const result = coordinateNpcDates([changing, other]);
        const declined = result.find(d => d.id === 'changing')!;
        assert.equal(declined.held, false);
        assert.equal(declined.declinedAt?.getTime(), knownAt.getTime());
        assert.match(declined.declined!, /改时间后/);
        assert.equal(result.find(d => d.id === 'other')!.held, true);
    }
});

test('同时对调时段先释放旧占用再协调，相邻时段不算冲突', () => {
    const first = date('first', '08:00', '19:00', { outcome: 'moved', actualStart: at('20:00'), knownAt: at('18:00') });
    const second = date('second', '09:00', '20:00', { outcome: 'moved', actualStart: at('19:00'), knownAt: at('18:00') });
    const result = coordinateNpcDates([first, second]);
    assert.ok(result.every(d => d.held && !d.declined));
    assert.deepEqual(coordinateNpcDates([second, first]), result);
    assert.ok(coordinateNpcDates([date('a', '08:00', '19:00'), date('b', '08:00', '20:00')]).every(d => d.held));
});

test('同刻改到相同空时段时，先承诺的优先，结果不受输入顺序影响', () => {
    const first = date('z-first', '08:00', '17:00', { outcome: 'moved', actualStart: at('21:00'), knownAt: at('16:00') });
    const second = date('a-second', '09:00', '19:00', { outcome: 'moved', actualStart: at('21:00'), knownAt: at('16:00') });
    const result = coordinateNpcDates([first, second]);
    assert.equal(result.find(d => d.id === 'z-first')!.held, true);
    assert.equal(result.find(d => d.id === 'a-second')!.held, false);
    assert.deepEqual(coordinateNpcDates([second, first]), result);
});

test('同截止时间的不同课程保留各自赶作业时段，同一作业跨天查询不重复', () => {
    const due = new Date('2026-11-06T08:00:00+08:00');
    const homework = ['20', '22'].map((hour, i) => ({ course: `合成课程${i}`, due, done: false, assigned: '2026-11-04', doneAt: new Date(`2026-11-05T${hour}:00:00+08:00`) }));
    const facts = { schedule, worldAt: (): WorldNow => ({ day: '2026-11-05', atSchool: true, parcels: [], events: [], homework }) };
    const start = new Date('2026-11-05T18:00:00+08:00');
    const end = new Date('2026-11-06T02:00:00+08:00');
    const found = obstaclesBetween(start, end, facts).filter(o => o.kind === 'homework');
    assert.equal(found.length, 2);
    assert.equal(new Set(found.map(o => o.id)).size, 2);
    assert.ok(found.every(o => !o.id.includes('合成课程')));
    const text = describeObstacles([day], start, facts)!;
    assert.ok(text.includes('合成课程0') && text.includes('合成课程1'));
    const lowDisclosure = { ...facts, worldAt: (): WorldNow => ({ ...facts.worldAt(), homework: homework.map(h => ({ ...h, course: '' })) }) };
    assert.equal(obstaclesBetween(start, end, lowDisclosure).filter(o => o.kind === 'homework').length, 2);
    const duplicate = { ...facts, worldAt: (): WorldNow => ({ ...facts.worldAt(), homework: [homework[0]!, homework[0]!] }) };
    assert.equal(obstaclesBetween(start, end, duplicate).filter(o => o.kind === 'homework').length, 1);
});

test('不同NPC的重叠邀请不能同时held，拒绝记录保留实际理由与时刻', () => {
    const world: World = { startDay: '2026-09-07', awayHolidays: [], events: [], asks: true,
        people: [{ id: 'su_yutong', name: '合成甲', relation: '同学' }, { id: 'chen_jianing', name: '合成乙', relation: '老同学' }] };
    const now = new Date('2029-11-27T20:00:00+08:00');
    const projected = worldAt(world, schedule, now)!;
    const sameDay = projected.dates!.filter(date => date.start.getDate() === 27);
    assert.equal(sameDay.length, 2);
    assert.equal(sameDay.filter(date => date.held).length, 1);
    const declined = sameDay.find(date => !date.held)!;
    assert.ok(declined.declined);
    assert.ok(declined.declinedAt && declined.declinedAt <= now);
});
