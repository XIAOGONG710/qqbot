import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWorld, type WorldSource } from '../src/world-source.ts';

const source = (): WorldSource => ({ start_day: '2026-11-05', away_holidays: [],
    weather: { tiers: ['test'], rain_chance: 0, temps: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), [10, 20] as [number, number]])) },
    cat: { name: '合成猫', tiers: [], feed: ['19:00', '20:00'], seen_chance: 0, food: { bag_days: 20, left: 20, reorder_at: 2 } },
    parcels: { tiers: ['test'], per_week: 1, arrive_days: [1, 1], keep_days: 1, items: ['合成物品'] },
    camera_fund: { tiers: ['test'], goal: 100, saved: 100, weekly: 0, deposit_day: 7 },
    homework: { tiers: [], kinds: ['hard'], chance: 0, early_chance: 0 },
    family_call: { tiers: [], weekday: 7, time: '20:00' }, people: [], events: [] });

test('源配置拒绝无效真实日历，兼容合法小年份及闰日', () => {
    for (const start_day of ['2026-02-30', '0100-02-29', '2026-13-01']) assert.throws(() => checkWorld({ ...source(), start_day }), /start_day/);
    for (const start_day of ['0000-02-29', '0099-12-31', '0100-01-01', '2024-02-29']) assert.doesNotThrow(() => checkWorld({ ...source(), start_day }));
    assert.throws(() => checkWorld({ ...source(), parcels: { ...source().parcels, after_meal_from: '2026-02-30' } }), /after_meal_from/);
    const body = { tiers: ['test'], period: { first: '2026-02-30', cycle: [28, 30], days: 5, cramps_chance: 0, detail_tiers: [] } };
    assert.throws(() => checkWorld({ ...source(), body }), /period.first/);
    assert.doesNotThrow(() => checkWorld({ ...source(), body: { ...body, period: { ...body.period, first: '0000-02-29' } } }));
});

test('源快递区间与保管期限同样不能跨出四位日期，合法最后一天截止保留', () => {
    assert.throws(() => checkWorld({ ...source(), start_day: '9999-12-31' }), /日期范围/);
    assert.throws(() => checkWorld({ ...source(), start_day: '9999-12-30', parcels: { ...source().parcels, keep_days: 2 } }), /日期范围/);
    assert.doesNotThrow(() => checkWorld({ ...source(), start_day: '9999-12-30' }));
});

test('源相机行程结束日期校验，普通跨年与小年份跨世纪仍合法', () => {
    const purchase = (date: string, from: string, minutes: number) => ({ date, from, minutes, where: '合成市场', what: '合成相机', price: 100 });
    for (const item of [purchase('9999-12-31', '23:50', 10), purchase('2026-02-30', '12:00', 30)]) {
        assert.throws(() => checkWorld({ ...source(), camera_fund: { ...source().camera_fund, purchase: item } }), /purchase/);
    }
    for (const item of [purchase('9999-12-31', '23:49', 10), purchase('0099-12-31', '23:50', 20), purchase('2026-12-31', '23:50', 20)]) {
        assert.doesNotThrow(() => checkWorld({ ...source(), camera_fund: { ...source().camera_fund, purchase: item } }));
    }
});

test('源首日猫粮补货同样按真实共享保管天数校验，未启用猫不强行产生补货', () => {
    const original = source();
    const active = { ...original.cat, tiers: ['test'], food: { ...original.cat.food, left: 0, reorder_at: 0 } };
    assert.throws(() => checkWorld({ ...original, start_day: '9999-12-30', cat: active }), /cat.*日期范围/);
    assert.doesNotThrow(() => checkWorld({ ...original, start_day: '9999-12-29', cat: active }));
    assert.doesNotThrow(() => checkWorld({ ...original, start_day: '9999-12-30' }));
});

test('猫可见而普通快递规则被档位裁掉时，要按运行时默认三天保管校验', () => {
    const original = source();
    const cat = { ...original.cat, tiers: ['cat-only'], food: { ...original.cat.food, left: 0, reorder_at: 0 } };
    assert.throws(() => checkWorld({ ...original, start_day: '9999-12-29', cat,
        parcels: { ...original.parcels, tiers: ['other-tier'], keep_days: 1 } }), /cat.*日期范围/);
    // 所有猫可见档都拿不到普通快递块时，不要拿别的档位的14天期限强加给猫粮。
    assert.doesNotThrow(() => checkWorld({ ...original, start_day: '9999-12-27', cat,
        parcels: { ...original.parcels, tiers: ['other-tier'], per_week: 0, keep_days: 14 } }));
});

test('源配置的四位民用日期判断在不同时区保持一致', () => {
    const original = process.env.TZ;
    try {
        for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Apia']) {
            process.env.TZ = zone;
            assert.doesNotThrow(() => checkWorld({ ...source(), start_day: '0099-12-31' }));
            assert.doesNotThrow(() => checkWorld({ ...source(), start_day: '9999-12-30' }));
            assert.throws(() => checkWorld({ ...source(), camera_fund: { ...source().camera_fund,
                purchase: { date: '9999-12-31', from: '23:50', minutes: 10, where: '合成市场', what: '合成相机', price: 100 } } }));
        }
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
