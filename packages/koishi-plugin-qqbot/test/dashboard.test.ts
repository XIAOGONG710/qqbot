import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../../bot/src/platform/config.ts';
import { FEATURE_GROUPS, FEATURES, featureStatuses, NOT_SWITCHES } from '../../bot/src/platform/features.ts';
// @ts-expect-error 手写的 ES 模块，没有类型
import { extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, GROUP_ORDER, overviewCounts } from '../client/dashboard.js';

// ADR 0120：控制台“状态”页的功能开关仪表盘

describe('功能总表：config 里的每个开关都在表里（新加一个开关忘了登记，这里会红）', () => {
    test('DEFAULTS 里每个布尔 / 模式开关要么在 FEATURES 里，要么在 NOT_SWITCHES 里', () => {
        const registered = new Set(FEATURES.map(f => f.key));
        const ignored = new Set(NOT_SWITCHES);
        const missing = Object.entries(DEFAULTS as Record<string, unknown>)
            .filter(([key, value]) => (typeof value === 'boolean' || typeof value === 'string') && !registered.has(key) && !ignored.has(key))
            .map(([key]) => key);
        assert.deepEqual(missing, [], `这些开关没登记进 bot/src/features.ts：${missing.join('、')}`);
    });

    test('表里的 key 都真的在 DEFAULTS 里；没有重复；模块名都是已知的；mode 类的默认值是字符串、bool 类是布尔', () => {
        const keys = FEATURES.map(f => f.key);
        assert.equal(new Set(keys).size, keys.length, '重复登记');
        for (const feature of FEATURES) {
            assert.ok(feature.key in (DEFAULTS as object), `${feature.key} 不在 DEFAULTS`);
            assert.ok((FEATURE_GROUPS as readonly string[]).includes(feature.group), `${feature.key} 的模块 ${feature.group}`);
            const value = (DEFAULTS as Record<string, unknown>)[feature.key];
            // 大多数 bool 开关直接存 boolean；像 DSH 这类插件分组开关使用
            // { enabled } 以便控制台继续扩展细项，但状态页仍按 bool 展示。
            const isBoolSwitch = typeof value === 'boolean' || (typeof value === 'object' && value !== null && typeof (value as { enabled?: unknown }).enabled === 'boolean');
            assert.equal(feature.kind === 'mode' ? typeof value : isBoolSwitch, feature.kind === 'mode' ? 'string' : true, feature.key);
            assert.ok(feature.label.length > 0);
            if (feature.adr) assert.match(feature.adr, /^\d{4}$/);
        }
    });

    test('featureStatuses：bool 看真假；mode 看是不是 off，并把模式带上', () => {
        const status = featureStatuses({ shape: true, photos: false, proactive: 'dryRun', stickers: 'off', festivals: 'greet' });
        const get = (key: string) => status.find(s => s.key === key)!;
        assert.equal(get('shape').on, true);
        assert.equal(get('photos').on, false);
        assert.deepEqual([get('proactive').on, get('proactive').mode], [true, 'dryRun']);
        assert.equal(get('stickers').on, false);
        assert.equal(get('stickers').mode, undefined);
        assert.equal(get('festivals').mode, 'greet');
        assert.equal(get('herNo').on, false, '没给的算关');
        assert.equal(status.length, FEATURES.length);
    });

    test('联系人筛选：本地按称呼 / QQ / 档位 / 当前状态过滤，忙碌只排除 idle', () => {
        const contacts = [
            { name: '小明', qq: 10001, tier: 'classmate', now: '上课', responder: { phase: 'waiting', reason: '等他停下' } },
            { name: '阿瑶', qq: 10002, tier: 'boyfriend', now: '休息', responder: { phase: 'idle' } },
        ];
        assert.deepEqual(filterContacts(contacts, '10002').map((row: { name: string }) => row.name), ['阿瑶']);
        assert.deepEqual(filterContacts(contacts, '男朋友').map((row: { name: string }) => row.name), ['阿瑶']);
        assert.deepEqual(filterContacts(contacts, 'waiting', true).map((row: { name: string }) => row.name), ['小明']);
        assert.deepEqual(filterContacts(contacts, '', true).map((row: { name: string }) => row.name), ['小明']);
    });

    test('总览计数：联系人、忙碌、重试和 DSH 状态一致', () => {
        const result = overviewCounts({
            contacts: [
                { responder: { phase: 'retry' } },
                { responder: { phase: 'idle' } },
                { responder: { phase: 'generating' } },
            ],
            features: [{ key: 'dsh', on: true }, { key: 'shape', on: false }],
        });
        assert.deepEqual(result, { contacts: 3, busy: 2, retrying: 1, dshOn: true, features: { on: 1, total: 2 } });
    });
});

describe('客户端的纯函数', () => {
    const features = featureStatuses({ shape: true, jokes: true, photos: true, proactive: 'on', stickers: 'send' });

    test('分组：照模块顺序；每组里开着的排前面；统计开了几个', () => {
        const groups = featureGroups(features);
        assert.deepEqual(groups.map((g: { name: string }) => g.name), GROUP_ORDER.filter((name: string) => features.some(f => f.group === name)));
        const speak = groups.find((g: { name: string }) => g.name === '说话');
        assert.ok(speak.items[0].on && speak.items.slice(0, speak.on).every((i: { on: boolean }) => i.on) && speak.items.slice(speak.on).every((i: { on: boolean }) => !i.on));
        assert.equal(speak.total, FEATURES.filter(f => f.group === '说话').length);
        assert.deepEqual(featureTotals(features), { on: 5, total: FEATURES.length });
        assert.deepEqual(featureGroups(undefined), []);
    });

    test('总表里出现了页面不认识的模块：排在最后，不丢', () => {
        const groups = featureGroups([...features, { key: 'x', label: '新东西', group: '新模块', on: true }]);
        assert.equal(groups.at(-1).name, '新模块');
    });

    test('标签保留模式；提示使用已启用/未启用和功能说明，不显示内部 ADR 编号', () => {
        const proactive = features.find(f => f.key === 'proactive')!;
        const stickers = features.find(f => f.key === 'stickers')!;
        assert.ok(!featureLabel(proactive).includes('（'), '主动消息 on 不加括号');
        assert.ok(featureLabel(stickers).endsWith('（会发）'), featureLabel(stickers));
        assert.ok(featureLabel(featureStatuses({ proactive: 'dryRun' }).find(f => f.key === 'proactive')!).endsWith('（试运行）'));
        assert.equal(featureTitle({ on: true, adr: '0109' }), '已启用');
        assert.equal(featureTitle({ on: false }), '未启用');
        assert.equal(featureTitle({ on: true, hint: '允许发送照片', adr: '0109' }), '已启用；允许发送照片');
    });

    test('货架 / 小梗 / 周报那几行：没有这一项就不出现；货架空着写清楚', () => {
        assert.deepEqual(extrasRows(undefined), []);
        assert.deepEqual(extrasRows({}), []);
        const rows = extrasRows({ photos: { count: 0, cat: 0, view: 0, work: 0 }, jokes: 0, report: { name: 'weekly-2026-11-22.md', text: '...' } });
        assert.equal(rows.length, 3);
        assert.match(rows[0].text, /空的/);
        assert.match(rows[1].text, /还没有/);
        assert.equal(rows[2].text, 'weekly-2026-11-22.md');
        assert.match(extrasRows({ photos: { count: 5, cat: 3, view: 2, work: 0 } })[0].text, /5 张（土豆 3、天空 2）/);
    });
});
