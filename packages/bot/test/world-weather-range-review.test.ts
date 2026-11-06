import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worldAt, type World } from '../src/world/world.ts';
import type { Schedule } from '../src/life/schedule.ts';

const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
const snapshot = (range: [number, number], rainChance: number, day = '2026-11-05') => {
    const world: World = { startDay: '2026-11-01', awayHolidays: [], people: [], events: [],
        weather: { rainChance, temps: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), range])) } };
    return worldAt(world, schedule, new Date(`${day}T12:00:00+08:00`))!.weather!;
};

test('下雨降温后窄温区不倒置，仅将过低的上限夹到已有低温', () => {
    for (const range of [[20, 20], [20, 21], [20, 22]] as [number, number][]) {
        assert.deepEqual(snapshot(range, 1), { rain: true, low: 22, high: 22 });
    }
    assert.deepEqual(snapshot([20.5, 22], 1), { rain: true, low: 22.5, high: 22.5 });
});

test('不下雨时窄温区保持修改前的日历随机结果', () => {
    assert.deepEqual(snapshot([20, 20], 0), { rain: false, low: 22, high: 22 });
    assert.deepEqual(snapshot([20, 21], 0), { rain: false, low: 22, high: 23 });
    assert.deepEqual(snapshot([20, 22], 0), { rain: false, low: 22, high: 24 });
});

test('原本有序的宽温区与恰好三度的雨天结果保持历史锚点不变', () => {
    // 修改前记录的合成锚点；不复制哈希算法来推算期望值。
    const expected = [
        ['2026-11-01', 8, 18, 15], ['2026-11-05', 12, 22, 19], ['2026-11-10', 9, 19, 16],
    ] as const;
    for (const [day, low, dryHigh, rainHigh] of expected) {
        assert.deepEqual(snapshot([10, 20], 0, day), { rain: false, low, high: dryHigh });
        assert.deepEqual(snapshot([10, 20], 1, day), { rain: true, low, high: rainHigh });
    }
    assert.deepEqual(snapshot([20, 23], 1), { rain: true, low: 22, high: 22 });
});
