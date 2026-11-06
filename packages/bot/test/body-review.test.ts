import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyAt, parseBody } from '../src/life/body.ts';
import type { Schedule } from '../src/life/schedule.ts';

const fail = (message: string): never => { throw new Error(message); };
const parse = (value: unknown) => parseBody(value, fail);
const period = { first: '2026-11-01', cycle: [28, 30], days: 5, crampsChance: 0.5, detail: true };
const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } },
    semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
};

test('身体配置只接受对象，可省略整个配置但不能把原始值或数组当空配置', () => {
    assert.equal(parse(undefined), undefined);
    assert.equal(parse(null), undefined);
    assert.deepEqual(parse({}), {});
    for (const value of [[], 1, true, 'body', { cold: null }, { period: null }, { cold: false }, { period: 0 }]) {
        assert.throws(() => parse(value), /body/);
    }
});

test('周期起点必须是真实日历日期，不能自动滚动到三月', () => {
    for (const first of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-01', '2026-11-00', '2026-1-01', 20261101]) {
        assert.throws(() => parse({ period: { ...period, first } }), /body.period/);
    }
    assert.ok(parse({ period: { ...period, first: '2024-02-29' } }));
});

test('周期必须是两个有序正安全整数，非法周期不能静默让状态消失', () => {
    for (const cycle of [[0, 0], [-2, -1], [30, 20], ['28', 30], [28.5, 30], [NaN, 30], [28, Infinity], [28, 1e20], [28], '28-30']) {
        assert.throws(() => parse({ period: { ...period, cycle } }), /body.period/);
    }
});

test('经期长度和概率的类型、有限性与区间都校验，且不能长于最短周期', () => {
    for (const days of [0, -1, 1.5, '5', Infinity, NaN, 29]) assert.throws(() => parse({ period: { ...period, days } }), /body.period/);
    for (const crampsChance of [-0.1, 1.1, Infinity, NaN, '0.5']) assert.throws(() => parse({ period: { ...period, crampsChance } }), /body.period/);
    for (const detail of ['true', 1, null]) assert.throws(() => parse({ period: { ...period, detail } }), /body.period/);
    assert.ok(parse({ period: { ...period, days: 28, crampsChance: 0 } }));
    assert.ok(parse({ period: { ...period, crampsChance: 1 } }));
});

test('感冒持续时间必须有界，JSON 溢出数和巨量天数不能让同步状态投影失去响应', () => {
    const overflow = JSON.parse('{"cold":{"perMonth":0,"days":1e309}}');
    assert.throws(() => parse(overflow), /body.cold/);
    for (const days of [0, -1, 1.5, '4', NaN, Infinity, 367, 1e9]) {
        assert.throws(() => parse({ cold: { perMonth: 0, days } }), /body.cold/);
    }
    // 直接调用投影器也不能跳过界限，避免合法 TS number 类型里的 Infinity 挂死进程。
    assert.throws(() => bodyAt({ cold: { perMonth: 0, days: Infinity } }, schedule, new Date('2026-11-05T12:00:00+08:00')), RangeError);
    for (const perMonth of [-1, 31, Infinity, NaN, '1']) assert.throws(() => parse({ cold: { perMonth, days: 4 } }), /body.cold/);
});

test('合法端点保持确定性并返回有效状态，零概率不会产生感冒', () => {
    const zero = parse({ cold: { perMonth: 0, days: 366 } })!;
    const now = new Date('2026-11-05T12:00:00+08:00');
    assert.equal(bodyAt(zero, schedule, now).cold, undefined);
    const certain = parse({ cold: { perMonth: 30, days: 1 }, period: { ...period, crampsChance: 1 } })!;
    assert.deepEqual(bodyAt(certain, schedule, now), bodyAt(certain, schedule, now));
    assert.deepEqual(bodyAt(certain, schedule, now).cold, { day: 1, of: 1 });
    assert.equal(bodyAt(certain, schedule, now).period?.day, 5);
});
