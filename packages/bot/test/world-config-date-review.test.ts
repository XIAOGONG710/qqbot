import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorld } from '../src/world/world.ts';

const base = { startDay: '2026-11-05', awayHolidays: [], people: [], events: [] };
const parcels = (arriveDays: [number, number], keepDays: number) => ({ perWeek: 1, arriveDays, keepDays, items: ['合成物品'] });
const camera = (date: string, from: string, minutes: number) => ({ goal: 100, saved: 100, weekly: 0, depositDay: 7,
    purchase: { date, from, minutes, where: '合成市场', what: '合成相机', price: 100 } });
const cat = (left: number, reorderAt: number) => ({ name: '合成猫', feed: ['19:00', '20:00'], seenChance: 0,
    food: { bagDays: 20, left, reorderAt } });

test('配置偏移不能只满足 JS Date 有限，还必须留在支持的四位日期范围', () => {
    for (const value of [
        { ...base, startDay: '9999-12-31', parcels: parcels([1, 1], 1) },
        { ...base, startDay: '9999-12-30', parcels: parcels([1, 1], 2) },
        { ...base, parcels: parcels([0, 4_000_000], 1) },
        { ...base, cameraFund: camera('9999-12-31', '23:50', 10) },
        { ...base, cameraFund: camera('9999-12-31', '23:50', 20) },
    ]) assert.throws(() => parseWorld(value, '合成日期配置'), /四位|YYYY-MM-DD|日期范围/);
});

test('保管截止按到货当天算第一天，最后一个支持日期可以合法保管一天', () => {
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-31', parcels: parcels([0, 0], 1) }, '合成配置'));
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-30', parcels: parcels([1, 1], 1) }, '合成配置'));
    assert.doesNotThrow(() => parseWorld({ ...base, cameraFund: camera('9999-12-31', '23:49', 10) }, '合成配置'));
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-31' }, '合成配置'));
});

test('小年份、世纪闰年和跨年不被当成1900年代，也不被任意禁止', () => {
    for (const startDay of ['0000-02-28', '0000-02-29', '0099-12-31', '0100-01-01', '2000-02-29', '2024-12-31']) {
        assert.doesNotThrow(() => parseWorld({ ...base, startDay, parcels: parcels([1, 1], 1) }, '合成配置'));
    }
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '0099-01-01', cameraFund: camera('0099-12-31', '23:50', 20) }, '合成配置'));
    assert.throws(() => parseWorld({ ...base, startDay: '0100-02-29' }, '合成配置'), /startDay/);
});

test('首日可能自动补猫粮时也检查固定两天到货及共享保管期限，禁用或充足库存不猜造首日订单', () => {
    assert.throws(() => parseWorld({ ...base, startDay: '9999-12-30', cat: cat(0, 0) }, '合成配置'), /cat.*日期范围/);
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-29', cat: cat(0, 0), parcels: { ...parcels([0, 0], 1), perWeek: 0 } }, '合成配置'));
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-31', cat: cat(0, -1) }, '合成配置'));
    assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-31', cat: cat(20, 0) }, '合成配置'));
});

test('配置的民用日期偏移判断不因运行机器时区而改变', () => {
    const original = process.env.TZ;
    try {
        for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Apia']) {
            process.env.TZ = zone;
            assert.doesNotThrow(() => parseWorld({ ...base, startDay: '0099-12-31', parcels: parcels([1, 1], 1) }, '合成配置'));
            assert.doesNotThrow(() => parseWorld({ ...base, startDay: '9999-12-30', parcels: parcels([1, 1], 1) }, '合成配置'));
            assert.throws(() => parseWorld({ ...base, cameraFund: camera('9999-12-31', '23:50', 20) }, '合成配置'));
        }
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
