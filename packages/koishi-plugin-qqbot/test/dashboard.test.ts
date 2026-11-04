import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../../bot/src/platform/config.ts';
import { FEATURE_GROUPS, FEATURES, featureStatuses, NOT_SWITCHES } from '../../bot/src/platform/features.ts';
// @ts-expect-error 手写的 ES 模块，没有类型
import { aiPhotoRuntimeRows, attentionDetail, capabilityBundles, capabilityTotals, dashboardTime, dshStatusLine, extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, GROUP_ORDER, lifeMoments, lifePulse, lifeTrend, memoryStatusDetail, mobileCompanionStatusDetail, overviewCounts, realWorldStatus, responderStatusText } from '../client/dashboard.js';

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
            for (const required of feature.requires ?? []) {
                assert.notEqual(required, feature.key, `${feature.key} 不能依赖自己`);
                assert.ok(keys.includes(required), `${feature.key} 依赖了没有登记的功能 ${required}`);
            }
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

    test('开关打开但依赖缺失时不冒充已生效，并只返回中文依赖名', () => {
        const status = featureStatuses({ worldThreads: true, depthRouting: true, factHim: true, memoryFeelings: true });
        const get = (key: string) => status.find(s => s.key === key)!;
        assert.equal(get('worldThreads').on, false);
        assert.equal(get('worldThreads').configured, true);
        assert.deepEqual(get('worldThreads').missing, ['日常小事 / 小测', '日子里的小起伏']);
        assert.deepEqual(get('depthRouting').missing, ['认真问她时深思']);
        assert.deepEqual(get('factHim').missing, ['逐条事实检查']);
        assert.deepEqual(get('memoryFeelings').missing, ['心境']);
        const ready = featureStatuses({ worldThreads: true, everydayLife: true, worldDrama: true }).find(s => s.key === 'worldThreads')!;
        assert.equal(ready.on, true);
        assert.equal(ready.configured, undefined);
        assert.equal(ready.missing, undefined);
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

    test('总览计数：回复重试与外部草稿待办统一进入顶部，不再误报没有待处理', () => {
        const result = overviewCounts({
            contacts: [
                { responder: { phase: 'retry' } },
                { responder: { phase: 'idle' } },
                { responder: { phase: 'generating' } },
                {},
            ],
            features: [
                { key: 'dsh', label: '外部顾问（按需咨询）', group: '工具', on: true },
                { key: 'shape', label: '形状控制（每条多长、几条）', group: '说话', on: false },
            ],
            externalDrafts: { pending: 2, approved: 3, publishing: 1, failed: 4 },
            extras: { aiPhotoDrafts: { total: 5, pending: 2, approved: 2, rejected: 1 } },
        });
        assert.deepEqual(result, {
            contacts: 4, busy: 2, attention: { total: 13, retrying: 1, drafts: 2, approved: 3, publishing: 1, failed: 4, aiPhotos: 2 },
            dshOn: true, features: { on: 1, blocked: 0, total: 2 }, capabilities: { on: 1, total: 6 },
        });
        assert.equal(attentionDetail(result.attention), '回复需重试 1 · 草稿待确认 2 · 已批准待发布 3 · 发布待核对 1 · 发布失败待处理 4 · AI 照片待审核 2');
        const approvedAndFailed = overviewCounts({ contacts: [], externalDrafts: { pending: 0, approved: 2, publishing: 0, failed: 1 } }).attention;
        assert.equal(approvedAndFailed.total, 3);
        assert.equal(attentionDetail(approvedAndFailed), '已批准待发布 2 · 发布失败待处理 1');
        const invalid = overviewCounts({ contacts: [], externalDrafts: { pending: -1, approved: NaN, publishing: 1.5, failed: '2' } }).attention;
        assert.equal(invalid.total, 0);
        assert.equal(invalid.aiPhotos, 0);
        assert.equal(attentionDetail(invalid), '当前没有需要处理的事项');
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
        assert.deepEqual(featureTotals(features), { on: 5, blocked: 0, total: FEATURES.length });
        assert.deepEqual(featureGroups(undefined), []);
    });

    test('总表里出现了页面不认识的模块：排在最后，不丢', () => {
        const groups = featureGroups([...features, { key: 'x', label: '新东西', group: '新模块', on: true }]);
        assert.equal(groups.at(-1).name, '新模块');
    });

    test('能力包把技术开关压成六个体验入口，但不制造新的总开关', () => {
        const source = featureStatuses({
            shape: true, speechCheck: true,
            herDays: true, autonomousLife: true, proactive: 'on',
            media: true, bilibili: 'dryRun', qzone: 'off',
            crossRecent: true, dsh: { enabled: true },
        });
        const bundles = capabilityBundles(source);
        assert.deepEqual(bundles.map((bundle: { name: string }) => bundle.name), [
            '对话与关系', '自主生活', '图片与语音', '社交空间', '记忆与边界', '外部能力',
        ]);
        assert.deepEqual(capabilityTotals(source), { on: 6, total: 6 });
        const social = bundles.find((bundle: { id: string }) => bundle.id === 'social');
        assert.equal(social.active, true);
        assert.ok(social.highlights.includes('刷 B 站发给他'));
        assert.ok(!social.highlights.some((label: string) => label.includes('说说')), '关闭的能力不进入摘要');
        assert.ok(bundles.every((bundle: { highlights: string[] }) => bundle.highlights.length <= 4));
        assert.deepEqual(capabilityTotals(undefined), { on: 0, total: 6 });
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
        const blocked = featureStatuses({ worldThreads: true }).find(f => f.key === 'worldThreads')!;
        assert.ok(featureLabel(blocked).endsWith('（还需开启其他功能）'));
        assert.match(featureTitle(blocked), /已开启但尚未生效；还需启用：日常小事 \/ 小测、日子里的小起伏/);
    });

    test('货架 / AI 草稿 / 小梗 / 周报那几行：没有这一项就不出现；待审核数用中文写清楚', () => {
        assert.deepEqual(extrasRows(undefined), []);
        assert.deepEqual(extrasRows({}), []);
        const rows = extrasRows({ photos: { count: 0, cat: 0, view: 0, work: 0 }, jokes: 0, report: { name: 'weekly-2026-11-22.md', text: '...' } });
        assert.equal(rows.length, 3);
        assert.match(rows[0].text, /空的/);
        assert.match(rows[1].text, /还没有/);
        assert.equal(rows[2].text, '11月22日生成');
        assert.equal(extrasRows({ report: { name: 'internal-report.dat' } })[0].text, '已生成', '不把内部文件名显示给用户');
        assert.match(extrasRows({ photos: { count: 5, cat: 3, view: 2, work: 0 } })[0].text, /5 张（土豆 3、天空 2）/);
        assert.deepEqual(extrasRows({ aiPhotoDrafts: { total: 4, pending: 2, approved: 1, rejected: 1 } }), [
            { label: 'AI 照片草稿', text: '2 张待审核（共 4 张；已通过 1、已拒绝 1）' },
        ]);
        assert.match(extrasRows({ aiPhotoDrafts: { total: 3, pending: 0, approved: 3, rejected: 0 } })[0].text, /没有待审核/);
        assert.match(extrasRows({ aiPhotoDrafts: { total: -1, pending: NaN, approved: 1.5, rejected: '2' } })[0].text, /共 0 张/);
    });

    test('AI 照片运行卡只显示中文角色和合法计数，异常值安全降级', () => {
        assert.deepEqual(aiPhotoRuntimeRows({
            feature: 'on', providers: ['local', 'primary', 'fallback'],
            usage: { attempts: 3, generated: 2, failed: 1, remaining: 1 },
            drafts: { pending: 2, approved: 4, rejected: 1 },
        }), [
            { label: '功能状态', text: '已开启（仍需人工审核）' },
            { label: '生图服务', text: '本地服务、主服务、备用服务' },
            { label: '今日用量', text: '尝试 3 次，成功 2 次，失败 1 次，剩余 1 次' },
            { label: '照片草稿', text: '待审核 2 张，已通过 4 张，已拒绝 1 张' },
        ]);
        const degraded = aiPhotoRuntimeRows({ feature: 'secret-code', providers: ['secret-provider'], degraded: 'token=C:\\private', drafts: { pending: -1 } });
        assert.deepEqual(degraded, [
            { label: '功能状态', text: '状态暂不可用' },
            { label: '生图服务', text: '未配置' },
            { label: '今日用量', text: '暂时无法读取' },
            { label: '照片草稿', text: '暂时无法读取' },
        ]);
        assert.doesNotMatch(JSON.stringify(degraded), /secret|private|token|\\/);
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
        assert.equal(mobileCompanionStatusDetail({ enabled: true, queued: 2 }), '等待配对 · 正在处理 2 条');
        assert.equal(mobileCompanionStatusDetail({ enabled: true, pairedClientId: 'phone', connected: false, queued: 1 }), '等待重连 · 正在处理 1 条');
        assert.equal(mobileCompanionStatusDetail({ enabled: true, pairedClientId: 'phone', connected: true, queued: 0 }), '已连接');
    });

    test('现实世界数据合并成中文摘要，并隐藏供应商错误原文', () => {
        assert.deepEqual(realWorldStatus(undefined), { text: '未开启', type: 'info', detail: '', healthy: false });
        const healthy = realWorldStatus({
            weather: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { hours: 24 }, qingdao: { hours: 24 } } },
            airQuality: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { hours: 24 } } },
            daylight: { fetchedAt: '2026-11-03T00:00:00.000Z', places: { jinan: { days: 16 } } },
            transport: { fetchedAt: '2026-11-03T00:00:00.000Z', source: 'secret-provider', locations: {
                jinan: { status: 'normal', observedAt: '2026-11-03T00:00:00.000Z', detail: '内部线路详情' },
                qingdao: { status: 'delayed', observedAt: '2026-11-03T00:00:00.000Z' },
            } },
            calendar: { years: [2026, 2027] },
        });
        assert.equal(healthy.text, '正常');
        assert.equal(healthy.healthy, true);
        assert.match(healthy.detail, /天气正常.*空气质量正常.*日照正常.*交通正常（2 个地点）.*法定日历正常/);
        assert.doesNotMatch(healthy.detail, /secret-provider|内部线路详情|delayed/);
        const warning = realWorldStatus({
            weather: { places: { jinan: { hours: 0, error: 'secret upstream response' } } },
            transport: { source: 'token=provider-secret', locations: {
                jinan: { error: 'Authorization: Bearer secret-token', detail: '供应商原文' },
                qingdao: { status: 'normal', observedAt: '2026-11-02T00:00:00.000Z', stale: true },
            } },
            calendar: { years: [2026, 2027], staleYears: [2027], error: 'token=secret' },
        });
        assert.equal(warning.text, '3 项需检查');
        assert.equal(warning.type, 'warning');
        assert.match(warning.detail, /天气1 个地点失败.*交通1 个地点失败.*法定日历获取失败/);
        assert.doesNotMatch(warning.detail, /secret|token|Authorization|供应商原文/);
        assert.match(realWorldStatus({ transport: { locations: {} } }).detail, /交通等待取数/);
    });

    test('生活卡把事实和数值翻成自然语言，不展示内部字段或凭空补故事', () => {
        const rows = lifePulse({
            schedule: true,
            contacts: [
                { tier: 'classmate', now: '在上课' },
                { tier: 'boyfriend', now: '在宿舍休息' },
            ],
            humanValues: {
                energy: 22, hunger: 78, stress: 81,
                relationship: { intimacy: 82, trust: 74, friction: 12 },
            },
            humanTrends: { windowMinutes: 60, values: { hunger: -18.2, energy: 6, stress: -4.5, unknown: 99 } },
            today: {
                mood: { name: '有点开心', reason: '下午的作业提前写完了' },
                books: [{ title: '长安的荔枝', amount: 52, unit: '页', finished: false, putDown: false }],
                highlights: [{ at: '2026-11-04T10:20:00.000Z', text: '喂过土豆，也见到它了' }],
            },
        });
        assert.deepEqual(rows, [
            { label: '现在', text: '在宿舍休息' },
            { label: '身体感受', text: '有些累，已经饿了，压力偏高' },
            { label: '近一小时', text: '饥饿感减轻 18.2，精力恢复 6，压力缓解 4.5' },
            { label: '心情', text: '有点开心，下午的作业提前写完了' },
            { label: '你们之间', text: '和你很亲近，信任稳定' },
            { label: '在读', text: '《长安的荔枝》第 52 页' },
            { label: '刚发生', text: '喂过土豆，也见到它了' },
        ]);
        assert.doesNotMatch(JSON.stringify(rows), /2026-|T10|intimacy|trust|friction/);
        assert.deepEqual(lifePulse({ schedule: false, contacts: [], today: { highlights: [] } }), [
            { label: '现在', text: '作息未启用' },
            { label: '刚发生', text: '今天还没有已记录的小事' },
        ]);
        assert.deepEqual(lifePulse({ schedule: true, contacts: [] }).at(-1), { label: '刚发生', text: '还没有可用的世界记录' });
        assert.deepEqual(lifePulse(undefined), []);
        assert.deepEqual(lifeTrend({ humanTrends: { windowMinutes: 30, values: { mood: 2, socialBattery: -3 } } }), { label: '近 30 分钟', text: '社交电量消耗 3，心情变好 2' });
        assert.equal(lifeTrend({ humanTrends: { windowMinutes: 60, values: { unknown: 9 } } }), undefined);
    });

    test('私有生活片段只取合法的世界账摘要并限制数量', () => {
        const moments = lifeMoments({ today: { highlights: [
            { at: '2026-11-04T10:20:00.000Z', text: '  喂过土豆  ' },
            { at: 'bad-time', text: '坏时间' },
            { at: '2026-11-04T09:00:00.000Z', text: '' },
            ...Array.from({ length: 8 }, (_, index) => ({ at: `2026-11-04T0${index}:00:00.000Z`, text: `片段${index}` })),
        ] } });
        assert.equal(moments.length, 6);
        assert.deepEqual(moments[0], { at: '2026-11-04T10:20:00.000Z', text: '喂过土豆' });
        assert.ok(moments.every((moment: { text: string }) => !moment.text.includes('坏')));
        assert.deepEqual(lifeMoments(undefined), []);
    });
});
