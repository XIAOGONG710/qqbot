import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorldConfig } from '../src/world/world-config.ts';
import { parseWorld, worldAt, type World } from '../src/world/world.ts';
import type { Schedule } from '../src/life/schedule.ts';

const basic: World = { startDay: '2026-11-05', awayHolidays: [], people: [], events: [] };
const full = () => ({ ...structuredClone(basic),
    weather: { rainChance: 0.3, temps: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), [-5.5, 25.5]])) },
    cat: { name: '合成猫', feed: ['19:00', '20:00'], seenChance: 0.5, food: { bagDays: 20, left: 5, reorderAt: 2 } },
    parcels: { perWeek: 2, arriveDays: [0, 2], keepDays: 3, items: ['合成物品'], afterMealFrom: '2026-11-05' },
    cameraFund: { goal: 1000, saved: 100, weekly: 10, depositDay: 7, purchase: { date: '2026-11-08', from: '12:00', minutes: 60, where: '合成市场', what: '合成相机', price: 1000 } },
    homework: { kinds: ['hard'], chance: 0.5, earlyChance: 0.5, groupedFrom: '2026-11-05' },
    familyCall: { weekday: 7, time: '20:00' },
    money: { allowance: 2000, payday: 1, start: 1000, askHome: 1000, detail: true,
        prices: { canteen: [10, 20], takeout: [20, 30], misc: [0, 5], catFood: 40, parcels: { 合成物品: 30 } },
        sideJobs: { perMonth: 1.5, pay: [10, 100], kinds: ['合成工作'] }, saving: { keepPerDay: 50, step: 50, max: 100 } },
    routine: { lunch: { from: '12:00', spread: 10, minutes: 30 }, dinner: { from: '17:50', spread: 10, minutes: 30 }, takeoutChance: 0.2,
        shower: { from: '22:00', spread: 20, minutes: [10, 20], chance: 1 } },
    events: [{ id: 'sample', text: '合成事件', window: 'evening', when: 'any', chance: 0.5 }],
});
const validate = (value: unknown) => validateWorldConfig(value, message => { throw new Error(message); });
const invalid = (value: unknown, path: RegExp) => assert.throws(() => validate(value), path);

test('基本世界与完整合法配置通过且不被修改，未知扩展字段和新 groupedFrom 保留', () => {
    assert.doesNotThrow(() => validate(basic));
    const value = { ...full(), extension: { keep: true } }; const snapshot = structuredClone(value);
    assert.doesNotThrow(() => validate(value)); assert.deepEqual(value, snapshot);
    assert.doesNotThrow(() => validate({ ...basic, money: { ...full().money, sideJobs: { perMonth: 0, kinds: [], pay: [0, 0] } },
        parcels: { ...full().parcels, perWeek: 0, items: [] }, cat: { ...full().cat, food: { bagDays: 20, left: 0, reorderAt: -1 } } }));
});

test('日期与基础形状必须真实有效，不将无效 startDay 自动滚动', () => {
    for (const startDay of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-11-00', '2026-1-01', 20261105]) invalid({ ...basic, startDay }, /startDay/);
    for (const value of [[], true, 1, 'world']) invalid(value, /对象/);
    invalid({ ...basic, awayHolidays: [1] }, /awayHolidays/);
    assert.doesNotThrow(() => validate({ ...basic, startDay: '2024-02-29' }));
});

test('money 完整校验有限安全数值、正步长、有序价格和每月实际到账日', () => {
    const money = full().money;
    for (const step of [0, -1, Infinity, NaN, '50', 0.5]) invalid({ ...basic, money: { ...money, saving: { ...money.saving, step } } }, /money.saving.step/);
    for (const start of [Infinity, NaN, '1000', Number.MAX_SAFE_INTEGER + 1]) invalid({ ...basic, money: { ...money, start } }, /money.start/);
    for (const payday of [0, 29, 32, 1.5]) invalid({ ...basic, money: { ...money, payday } }, /money.payday/);
    for (const canteen of [[], [10], [20, 10], [-1, 5], [10, Infinity], ['10', 20]]) invalid({ ...basic, money: { ...money, prices: { ...money.prices, canteen } } }, /money.prices.canteen/);
    invalid({ ...basic, money: { ...money, sideJobs: { perMonth: 1, pay: [1, 2], kinds: [] } } }, /money.sideJobs.kinds/);
    invalid({ ...basic, money: { ...money, sideJobs: { perMonth: 29, pay: [1, 2], kinds: ['x'] } } }, /money.sideJobs.perMonth/);
    invalid({ ...basic, money: { ...money, prices: {} } }, /money.prices/);
});

test('快递启用时物品不能为空，延迟和保管天数有序且可形成有效日期', () => {
    const parcels = full().parcels;
    invalid({ ...basic, parcels: { ...parcels, items: [] } }, /parcels.items/);
    for (const arriveDays of [[-1, 2], [3, 1], [1, Infinity], [1.5, 2], [1], [0, Number.MAX_SAFE_INTEGER]]) invalid({ ...basic, parcels: { ...parcels, arriveDays } }, /parcels.arriveDays/);
    for (const keepDays of [0, -1, Infinity, 1.5]) invalid({ ...basic, parcels: { ...parcels, keepDays } }, /parcels.keepDays/);
    invalid({ ...basic, parcels: { ...parcels, afterMealFrom: '2026-02-30' } }, /parcels.afterMealFrom/);
    assert.doesNotThrow(() => validate({ ...basic, parcels: { ...parcels, perWeek: 14 } }));
});

test('天气必须覆盖所有月份且每个温度区间有限有序', () => {
    const weather = full().weather;
    invalid({ ...basic, weather: { rainChance: 0, temps: {} } }, /weather.temps/);
    for (const pair of [[30, 10], [Infinity, Infinity], [10], ['10', 20]]) invalid({ ...basic, weather: { ...weather, temps: { ...weather.temps, 11: pair } } }, /weather.temps/);
    for (const rainChance of [-0.1, 1.1, NaN, Infinity]) invalid({ ...basic, weather: { ...weather, rainChance } }, /weather.rainChance/);
});

test('相机购买、猫粮及视频的日期、时段、库存和星期都验证', () => {
    const { cameraFund, cat, familyCall } = full();
    for (const minutes of [0, -10, Infinity, NaN, 1.5]) invalid({ ...basic, cameraFund: { ...cameraFund, purchase: { ...cameraFund.purchase, minutes } } }, /cameraFund.purchase.minutes/);
    invalid({ ...basic, cameraFund: { ...cameraFund, purchase: { ...cameraFund.purchase, date: '2026-02-30' } } }, /cameraFund.purchase.date/);
    invalid({ ...basic, cameraFund: { ...cameraFund, depositDay: 0 } }, /cameraFund.depositDay/);
    for (const feed of [['25:00', '26:00'], ['20:00', '19:00'], [19, 20]]) invalid({ ...basic, cat: { ...cat, feed } }, /cat.feed/);
    invalid({ ...basic, cat: { ...cat, food: { ...cat.food, bagDays: 0 } } }, /cat.food.bagDays/);
    invalid({ ...basic, cat: { ...cat, seenChance: 2 } }, /cat.seenChance/);
    invalid({ ...basic, familyCall: { ...familyCall, weekday: 0 } }, /familyCall.weekday/);
});

test('日常占用时长必须正向有限，饭点与洗澡参数完整且区间有序', () => {
    const routine = full().routine;
    for (const minutes of [0, -10, Infinity, NaN, 0.5, 1441]) invalid({ ...basic, routine: { ...routine, lunch: { ...routine.lunch, minutes } } }, /routine.lunch.minutes/);
    invalid({ ...basic, routine: { ...routine, shower: { ...routine.shower, minutes: [20, 10] } } }, /routine.shower.minutes/);
    invalid({ ...basic, routine: { ...routine, dinner: { ...routine.dinner, from: '24:00' } } }, /routine.dinner.from/);
    invalid({ ...basic, routine: { ...routine, takeoutChance: Infinity } }, /routine.takeoutChance/);
});

test('事件只接受自有时段枚举，校验概率、过滤条件和费用；作业支持合法分组生效日', () => {
    const event = full().events[0]!;
    for (const window of ['__proto__', 'constructor', 'toString', 'night', 1]) invalid({ ...basic, events: [{ ...event, window }] }, /events\[0\].window/);
    invalid({ ...basic, events: [{ ...event, chance: Infinity }] }, /events\[0\].chance/);
    invalid({ ...basic, events: [{ ...event, cost: { amount: [20, 10], what: '合成花销' } }] }, /events\[0\].cost.amount/);
    invalid({ ...basic, events: [{ ...event, months: [13] }] }, /events\[0\].months/);
    invalid({ ...basic, events: [{ ...event, weekdays: [0] }] }, /events\[0\].weekdays/);
    invalid({ ...basic, homework: { kinds: ['hard'], chance: Infinity, earlyChance: 0 } }, /homework.chance/);
    invalid({ ...basic, homework: { kinds: ['unknown'], chance: 0, earlyChance: 0 } }, /homework.kinds/);
    invalid({ ...basic, homework: { kinds: ['hard'], chance: 0, earlyChance: 0, groupedFrom: '2026-02-30' } }, /homework.groupedFrom/);
});

test('parseWorld 接入后在启动边界拒绝七类复现，不等到投影时崩溃或产生 NaN', () => {
    const value = full();
    for (const change of [
        { startDay: '2026-02-30' },
        { money: { ...value.money, saving: { ...value.money.saving, step: 0 } } },
        { weather: { rainChance: 0, temps: {} } },
        { events: [{ ...value.events[0], window: '__proto__' }] },
        { parcels: { ...value.parcels, items: [] } },
        { routine: { ...value.routine, lunch: { ...value.routine.lunch, minutes: -10 } } },
        { cameraFund: { ...value.cameraFund, purchase: { ...value.cameraFund.purchase, minutes: Infinity } } },
    ]) assert.throws(() => parseWorld({ ...basic, ...change }, '合成配置'), /world/);
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
        periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
        kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
    const parsed = parseWorld(value, '合成配置')!;
    const snapshot = worldAt(parsed, schedule, new Date('2026-11-05T23:00:00+08:00'))!;
    assert.ok(Number.isFinite(snapshot.cameraFund!.saved));
    assert.ok(snapshot.routine!.meals.every(meal => meal.end > meal.start));
});

test('事件的NPC引用必须存在，错误仅包含字段路径而不泄漏未知引用值', () => {
    const secret = '合成私密NPC引用标记';
    const event = { id: 'reference', text: '{person}说了一件事', window: 'morning', when: 'any', chance: 1, person: secret };
    assert.throws(() => parseWorld({ ...basic, events: [event] }, '合成配置'), error => error instanceof Error
        && /events\[0\]\.person/.test(error.message) && !error.message.includes(secret));
    assert.doesNotThrow(() => parseWorld({ ...basic, people: [{ id: secret, name: '合成NPC', relation: '同学' }], events: [event] }, '合成配置'));
    const { person: _person, ...generic } = event;
    assert.doesNotThrow(() => parseWorld({ ...basic, events: [generic] }, '合成配置'));
});
