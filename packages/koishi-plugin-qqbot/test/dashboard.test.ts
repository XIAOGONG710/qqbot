import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../../bot/src/platform/config.ts';
import { FEATURE_GROUPS, FEATURES, featureStatuses, NOT_SWITCHES } from '../../bot/src/platform/features.ts';
// @ts-expect-error 手写的 ES 模块，没有类型
import { dashboardTime, dshStatusLine, extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, GROUP_ORDER, memoryStatusDetail, mobileCompanionStatusDetail, overviewCounts, realWorldStatus, responderStatusText } from '../client/dashboard.js';

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
            { name: '小明', qq: 10001, tier: 'classmate', now: '上课', responder: { phase: 'waiting', reason: 'internal-secret-code' } },
            { name: '阿瑶', qq: 10002, tier: 'boyfriend', now: '休息', responder: { phase: 'idle' } },
            { name: '旧状态', qq: 10003, tier: 'known', now: '未知' },
        ];
        assert.deepEqual(filterContacts(contacts, '10002').map((row: { name: string }) => row.name), ['阿瑶']);
        assert.deepEqual(filterContacts(contacts, '男朋友').map((row: { name: string }) => row.name), ['阿瑶']);
        assert.deepEqual(filterContacts(contacts, '等待', true).map((row: { name: string }) => row.name), ['小明']);
        assert.deepEqual(filterContacts(contacts, 'waiting', true), [], '搜索不要求用户知道内部阶段码');
        assert.deepEqual(filterContacts(contacts, 'internal-secret-code'), [], '未展示的内部原因不进入搜索索引');
        assert.deepEqual(filterContacts(contacts, '', true).map((row: { name: string }) => row.name), ['小明']);
        assert.equal(responderStatusText({ phase: 'retry' }), '回复遇到问题，稍后再试');
    });

    test('总览计数：联系人、忙碌、重试和 DSH 状态一致', () => {
        const result = overviewCounts({
            contacts: [
                { responder: { phase: 'retry' } },
                { responder: { phase: 'idle' } },
                { responder: { phase: 'generating' } },
                {},
            ],
            features: [{ key: 'dsh', on: true }, { key: 'shape', on: false }],
        });
        assert.deepEqual(result, { contacts: 4, busy: 2, retrying: 1, dshOn: true, features: { on: 1, total: 2 } });
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

    test('标签：开着的写上模式（试运行 / 会发），“已启用”不重复写；提示里带开关说明', () => {
        const proactive = features.find(f => f.key === 'proactive')!;
        const stickers = features.find(f => f.key === 'stickers')!;
        assert.ok(!featureLabel(proactive).includes('（'), '主动消息 on 不加括号');
        assert.ok(featureLabel(stickers).endsWith('（会发）'), featureLabel(stickers));
        assert.ok(featureLabel(featureStatuses({ proactive: 'dryRun' }).find(f => f.key === 'proactive')!).endsWith('（试运行）'));
        // 2026-11-03：GPT 把控制台简化成中文（开着/关着 → 已启用/未启用），测试跟着对齐
        assert.equal(featureTitle({ on: true }), '已启用');
        assert.equal(featureTitle({ on: false }), '未启用');
        assert.equal(featureTitle({ on: true, hint: 'ADR 0109' }), '已启用；ADR 0109');
    });

    test('货架 / 小梗 / 周报那几行：没有这一项就不出现；货架空着写清楚', () => {
        assert.deepEqual(extrasRows(undefined), []);
        assert.deepEqual(extrasRows({}), []);
        const rows = extrasRows({ photos: { count: 0, cat: 0, view: 0, work: 0 }, jokes: 0, report: { name: 'weekly-2026-11-22.md', text: '...' } });
        assert.equal(rows.length, 3);
        assert.match(rows[0].text, /空的/);
        assert.match(rows[1].text, /还没有/);
        assert.equal(rows[2].text, '11月22日生成');
        assert.equal(extrasRows({ report: { name: 'internal-report.dat' } })[0].text, '已生成', '不把内部文件名显示给用户');
        assert.match(extrasRows({ photos: { count: 5, cat: 3, view: 2, work: 0 } })[0].text, /5 张（土豆 3、天空 2）/);
    });

    test('DSH 状态只展示连接结果和时间，不泄露错误原文', () => {
        assert.deepEqual(dshStatusLine(undefined), { text: '未启用', type: 'info', detail: '' });
        assert.match(dshStatusLine({ enabled: true }).detail, /连接结果/);
        assert.equal(dshStatusLine({ enabled: true, lastProbe: { ok: false, at: '2026-11-03T00:00:00.000Z', model: 'm', latencyMs: 12, error: 'secret-token' } }).text, '探测失败');
        const detail = dshStatusLine({ enabled: true, lastProbe: { ok: true, at: '2026-11-03T00:00:00.000Z', model: 'm', latencyMs: 12 } }).detail;
        assert.match(detail, /^最近探测 \d+月\d+日 \d{2}:\d{2} · 12 毫秒$/);
        assert.doesNotMatch(detail, /2026-|T00|\bms\b/);
        assert.doesNotMatch(dshStatusLine({ enabled: true, lastProbe: { ok: true, at: 'bad' } }).detail, /undefined|NaN/);
        assert.equal(dashboardTime('not-a-date'), '时间未知');
    });

    test('连接摘要把记忆活动和手机积压合并成简短中文', () => {
        assert.equal(memoryStatusDetail(undefined), '功能未开启');
        assert.equal(memoryStatusDetail({}), '正在检查');
        assert.equal(memoryStatusDetail({ health: { ok: false } }), '暂时不可用，请检查设置');
        const memory = memoryStatusDetail({
            health: { ok: true },
            lastWrite: { at: '2026-11-03T00:00:00.000Z', ok: true },
            lastRecall: { at: '2026-11-03T01:00:00.000Z', ok: false },
        });
        assert.match(memory, /^服务正常 · 最近召回失败 \d+月\d+日 \d{2}:\d{2}$/);
        assert.equal(mobileCompanionStatusDetail(undefined), '暂未启用');
        assert.equal(mobileCompanionStatusDetail({ enabled: true, queued: 2 }), '等待配对 · 待发送 2 条');
        assert.equal(mobileCompanionStatusDetail({ enabled: true, pairedClientId: 'phone', connected: false, queued: 1 }), '等待重连 · 待发送 1 条');
    });

    test('现实世界数据合并成中文摘要，并隐藏供应商错误原文', () => {
        assert.deepEqual(realWorldStatus(undefined), { text: '未开启', type: 'info', detail: '', healthy: false });
        const healthy = realWorldStatus({
            weather: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { hours: 24 }, qingdao: { hours: 24 } } },
            airQuality: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { hours: 24 } } },
            daylight: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { days: 16 } } },
            calendar: { years: [2026, 2027] },
        });
        assert.equal(healthy.text, '正常');
        assert.equal(healthy.healthy, true);
        assert.match(healthy.detail, /天气正常.*空气质量正常.*日照正常.*法定日历正常/);
        const warning = realWorldStatus({
            weather: { places: { jinan: { hours: 0, error: 'secret upstream response' } } },
            calendar: { years: [2026, 2027], staleYears: [2027], error: 'token=secret' },
        });
        assert.equal(warning.text, '2 项需检查');
        assert.equal(warning.type, 'warning');
        assert.match(warning.detail, /天气1 个地点失败.*法定日历获取失败/);
        assert.doesNotMatch(warning.detail, /secret|token/);
    });
});
