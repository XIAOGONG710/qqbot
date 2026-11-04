import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parcelPrice, type Money } from '../src/life/money.ts';
import { parseWorld, worldAt } from '../src/world/world.ts';
import type { Schedule } from '../src/life/schedule.ts';

const money: Money = { allowance: 2000, payday: 1, start: 1000, askHome: 1000, detail: true,
    prices: { canteen: [0, 0], takeout: [0, 0], misc: [0, 0], catFood: 45, parcels: {} },
    saving: { keepPerDay: 0, step: 50, max: 100 } };

test('物品名可与原型成员相同，缺少自有价格时一律使用默认价', () => {
    for (const item of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '普通物品']) {
        assert.equal(parcelPrice(money, item, false), 30, item);
        assert.equal(parcelPrice(money, item, true), 45, '猫粮仍使用独立价格');
    }
});

test('显式自有价格包括零价、保留字物品名和无原型字典都按原配置结算', () => {
    const configured: Money = { ...money, prices: { ...money.prices,
        parcels: JSON.parse('{"constructor":17,"__proto__":18,"toString":0}') as Record<string, number> } };
    assert.equal(parcelPrice(configured, 'constructor', false), 17);
    assert.equal(parcelPrice(configured, '__proto__', false), 18);
    assert.equal(parcelPrice(configured, 'toString', false), 0);
    const inherited = Object.create({ inherited: 999, constructor: 888 }) as Record<string, number>;
    inherited.own = 12;
    const other = { ...money, prices: { ...money.prices, parcels: inherited } };
    assert.equal(parcelPrice(other, 'inherited', false), 30);
    assert.equal(parcelPrice(other, 'own', false), 12);
    assert.equal(parcelPrice({ ...money, prices: { ...money.prices, parcels: Object.create(null) as Record<string, number> } }, 'constructor', false), 30);
});

test('完整世界配置中的合法保留字物品名不会使现金账变为 NaN', () => {
    const world = parseWorld({ startDay: '2026-11-05', awayHolidays: [], people: [], events: [], money,
        parcels: { perWeek: 7, arriveDays: [0, 0], keepDays: 3, items: ['constructor'] } }, '合成配置')!;
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
        periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
        kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
    assert.equal(worldAt(world, schedule, new Date('2026-11-05T13:00:00+08:00'))!.money!.balance, 970);
});
