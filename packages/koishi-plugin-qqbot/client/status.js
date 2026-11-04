// 状态页：插件在不在跑、NapCat / Hindsight 连没连上、名单里每人现在在等什么（ADR 0010）。不显示聊天内容。
import { computed, defineComponent, h, ref } from 'vue';
import { store } from '@koishijs/client';
import { c, clock, tag, tierLabel } from './common.js';
import { attentionDetail, dshStatusLine, extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, lifePulse, memoryStatusDetail, mobileCompanionStatusDetail, overviewCounts, realWorldStatus, responderStatusText } from './dashboard.js';

const PROACTIVE_MODES = { off: ['关', 'info'], dryRun: ['试运行（只写日志不发）', 'warning'], on: ['开', 'success'] };

/** 主动消息（ADR 0011）：下一次几点、什么时机；他没回时先不排；今天主动了几条。不显示内容 */
function proactiveText(p) {
    if (!p) return '—';
    const parts = [];
    if (p.paused) parts.push('已暂停');
    parts.push(p.next ? `计划 ${clock(p.next.at)} 联系` : '暂时没有计划');
    parts.push(`今天已主动联系 ${p.today} 次${p.mode === 'dryRun' ? '（试运行）' : ''}`);
    return parts.join('；');
}

function humanValuesLine(values) {
    if (!values) return [tag('自主生活未开启', 'info')];
    const positiveLevel = value => value >= 75 ? 'success' : value <= 25 ? 'danger' : 'warning';
    const loadLevel = value => value >= 75 ? 'danger' : value <= 25 ? 'success' : 'warning';
    const relationship = values.relationship;
    return [
        tag(`精力 ${values.energy}`, positiveLevel(values.energy)),
        tag(`饥饿 ${values.hunger}`, loadLevel(values.hunger)),
        tag(`压力 ${values.stress}`, loadLevel(values.stress)),
        h('span', { class: 'qqbot-muted' }, ` 心情 ${values.mood} · 健康 ${values.health} · 动机 ${values.motivation} · 孤独 ${values.loneliness}${relationship ? ` · 亲密 ${relationship.intimacy} · 信任 ${relationship.trust} · 熟悉 ${relationship.familiarity} · 依恋 ${relationship.attachment} · 摩擦 ${relationship.friction}` : ''}`),
    ];
}

/** 把底层数值、世界账和作息合成一张生活卡；完整数字仍可展开查看。 */
function lifePulsePanel(status) {
    const rows = lifePulse(status);
    if (!rows.length) return null;
    return h('section', { class: 'qqbot-life-card' }, [
        h('div', { class: 'qqbot-life-head' }, [
            h('strong', null, '她此刻的生活'),
            h('span', { class: 'qqbot-muted' }, '来自作息、世界账和数值投影，不由模型临时编写'),
        ]),
        h('div', { class: 'qqbot-summary' }, rows.map(row => h('div', { class: 'qqbot-summary-row' }, [
            h('span', { class: 'qqbot-label' }, row.label),
            h('span', null, row.text),
        ]))),
        status.humanValues ? h('details', { class: 'qqbot-life-values' }, [
            h('summary', null, '查看完整数值'),
            h('div', { class: 'qqbot-life-values-body' }, humanValuesLine(status.humanValues)),
        ]) : null,
    ]);
}

/** 手机伴侣能力清单：展示确认边界，避免控制台和协议各自维护一份动作说明。 */
function phoneActionsPanel(actions) {
    if (!actions?.length) return null;
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, `手机伴侣能力　${actions.length} 项`),
        h('div', { class: 'qqbot-summary' }, actions.map(action => h('div', { class: 'qqbot-summary-row' }, [
            h('span', { class: 'qqbot-label' }, action.description),
                h('span', null, [
                    tag(action.requiresConfirmation ? '需确认' : '自动', action.requiresConfirmation ? 'warning' : 'success'),
                    action.reversible ? h('span', { class: 'qqbot-muted' }, ' 可撤回') : null,
                ]),
        ]))),
    ]);
}

function externalPlatformsPanel(platforms, drafts) {
    if (!platforms) return null;
    const labels = { tieba: '百度贴吧', douyin: '抖音', xiaohongshu: '小红书' };
    const modes = {
        off: ['未启用', 'info'],
        draft: ['只生成草稿', 'warning'],
        authorized: ['授权模式，等待官方适配器', 'warning'],
    };
    const draftLine = drafts ? h('div', { class: 'qqbot-summary-row' }, [
        h('span', { class: 'qqbot-label' }, '统一草稿箱'),
        h('span', null, [
            tag(`待确认 ${drafts.pending ?? 0}`, drafts.pending ? 'warning' : 'success'),
            drafts.approved ? tag(`已批准 ${drafts.approved}`, 'warning') : null,
            drafts.publishing ? tag(`发布待核对 ${drafts.publishing}`, 'danger') : null,
            h('span', { class: 'qqbot-muted' }, ` · 共 ${drafts.total ?? 0} 条${drafts.failed ? ` · 失败 ${drafts.failed}` : ''}`),
        ].filter(Boolean)),
    ]) : null;
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, '外部平台接入'),
        h('div', { class: 'qqbot-summary' }, [...Object.entries(labels).map(([key, label]) => {
            const [text, type] = modes[platforms[key] ?? 'off'] ?? modes.off;
            return h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, label), tag(text, type)]);
        }), draftLine].filter(Boolean)),
    ]);
}

/** 功能开关（ADR 0120）：按模块分组，开着的亮绿色、关着的灰色；鼠标放上去看 ADR 编号。页面文件是从仓库直接读的：插件还是旧代码（没重启）时状态里没有 features */
function featurePanel(status) {
    if (!status.features) return h('p', { class: 'qqbot-muted' }, '功能开关：重启 Koishi 后显示');
    const { on, total } = featureTotals(status.features);
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, `功能开关　已开启 ${on} / ${total}`),
        h('div', { class: 'qqbot-feature-groups' }, featureGroups(status.features).map(group => h('div', { class: 'qqbot-feature-group' }, [
            h('span', { class: 'qqbot-label' }, `${group.name} ${group.on}/${group.total}`),
            h('span', { class: 'qqbot-chips' }, group.items.map(item => h('span', { class: 'qqbot-chip', title: featureTitle(item) }, [tag(featureLabel(item), item.on ? 'success' : 'info')]))),
        ]))),
    ]);
}

/** 照片货架、小梗、最近一份周报（ADR 0120）：对应的功能没开就没有这几行；周报是只有数字的文字 */
function extrasPanel(status) {
    const rows = extrasRows(status.extras);
    if (!rows.length) return null;
    return h('div', { class: 'qqbot-summary', style: 'margin-top: 16px' }, [
        ...rows.map(row => h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, row.label), h('span', null, row.text)])),
        status.extras?.report ? h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, '周报'), tag('已生成', 'success')]) : null,
    ]);
}

function overviewCard(label, value, detail, type = 'info') {
    return h('div', { class: 'qqbot-kpi' }, [
        h('div', { class: 'qqbot-kpi-label' }, label),
        h('div', { class: 'qqbot-kpi-value' }, tag(value, type)),
        h('div', { class: 'qqbot-kpi-detail' }, detail),
    ]);
}

function connectionCard(label, online, detail) {
    return h('div', { class: 'qqbot-connection' }, [
        h('span', { class: ['qqbot-health-dot', online ? 'is-on' : 'is-off'] }),
        h('span', { class: 'qqbot-connection-label' }, label),
        h('span', { class: 'qqbot-muted' }, detail),
    ]);
}

export const StatusTab = defineComponent({
    setup() {
        const query = ref('');
        const activeOnly = ref(false);
        const filteredContacts = computed(() => {
            const status = store.qqbot?.status;
            return filterContacts(status?.contacts, query.value, activeOnly.value);
        });
        return () => {
            const data = store.qqbot;
            if (!data) return h('p', null, '正在读取……');
            const status = data.status;
            const counts = overviewCounts(status);
            const dshFeature = status?.features?.find(feature => feature.key === 'dsh');
            const dsh = dshStatusLine(status?.dsh ?? (dshFeature?.on ? { enabled: true } : undefined));
            const worldData = realWorldStatus(status);
            const rows = status ? [
                ['作息', status ? [status.schedule ? tag('按作息运行', 'success') : tag('未启用', 'warning')] : [tag('—', 'info')]],
                ['按心情回复', status ? [status.moody && status.schedule ? tag('已启用', 'success') : tag('未启用', 'info')] : [tag('—', 'info')]],
                ['说话检查', status ? [status.speechCheck === false ? tag('未启用', 'info') : tag('已启用', 'success')] : [tag('—', 'info')]],
                ['陌生好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
                ['主动联系', status ? [tag(...(PROACTIVE_MODES[status.proactive ?? 'off'] ?? ['未启用', 'info']))] : [tag('—', 'info')]],
            ] : [
                ['插件', data.running ? [tag('运行正常', 'success')] : [tag('未运行', 'danger')]],
                ['QQ 连接', data.napcat?.online ? [tag('已连接', 'success')] : [tag('未连接', 'danger')]],
                ...(data.error ? [['处理建议', [h('span', { class: 'qqbot-muted' }, data.error)]]] : []),
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const kpis = h('div', { class: 'qqbot-kpis' }, [
                overviewCard('联系人', counts.contacts, `${counts.busy} 个正在处理`, counts.busy ? 'warning' : 'success'),
                overviewCard('功能开关', `${counts.features.on}/${counts.features.total}`, '当前实例已启用', counts.features.on ? 'success' : 'info'),
                overviewCard('外部顾问', counts.dshOn ? '已开启' : '已关闭', counts.dshOn ? '可以按需咨询' : '暂未启用', counts.dshOn ? 'success' : 'info'),
                overviewCard('待处理', counts.attention.total, attentionDetail(counts.attention), counts.attention.total ? 'danger' : 'success'),
            ]);
            const connections = h('div', { class: 'qqbot-connections' }, [
                connectionCard('插件', data.running, data.running ? '正在运行' : '请查看设置和日志'),
                connectionCard('QQ 连接', data.napcat?.online === true, data.napcat?.online ? '消息通道正常' : '等待连接'),
                connectionCard('长期记忆', Boolean(status.memory?.health?.ok), memoryStatusDetail(status.memory)),
                connectionCard('现实世界数据', worldData.healthy, worldData.detail || worldData.text),
                connectionCard('外部顾问', dsh.text === '连接正常', dsh.detail || dsh.text),
                connectionCard('手机伴侣', status.mobileCompanion?.enabled === true && status.mobileCompanion.connected === true, mobileCompanionStatusDetail(status.mobileCompanion)),
            ]);
            const features = featurePanel(status);
            const extras = extrasPanel(status);
            const phoneActions = phoneActionsPanel(data.phoneActions);
            const externalPlatforms = externalPlatformsPanel(status.externalPlatforms, status.externalDrafts);
            const pulse = lifePulsePanel(status);
            const contactToolbar = h('div', { class: 'qqbot-contact-toolbar' }, [
                h('div', { class: 'qqbot-section-title' }, [h('strong', null, '联系人'), h('span', { class: 'qqbot-muted' }, `显示 ${filteredContacts.value.length}/${counts.contacts}`)]),
                h(c('el-input'), {
                    modelValue: query.value, 'onUpdate:modelValue': value => { query.value = value; },
                    clearable: true, placeholder: '搜索联系人或当前状态', class: 'qqbot-contact-search',
                }),
                h(c('el-checkbox'), { modelValue: activeOnly.value, 'onUpdate:modelValue': value => { activeOnly.value = value; } }, () => '只看忙碌'),
            ]);
            const table = h(c('el-table'), { data: filteredContacts.value, border: true, stripe: true, size: 'small', emptyText: query.value || activeOnly.value ? '没有符合条件的联系人' : '暂无联系人', style: 'width: 100%; margin-top: 10px' }, () => [
                h(c('el-table-column'), { label: '称呼', prop: 'name', width: 130 }),
                h(c('el-table-column'), { label: '关系', width: 100 }, { default: ({ row }) => tierLabel(row.tier) }),
                h(c('el-table-column'), { label: '当前状态', minWidth: 180 }, { default: ({ row }) => responderStatusText(row.responder) }),
                h(c('el-table-column'), { label: '主动联系', minWidth: 180 }, { default: ({ row }) => proactiveText(row.proactive) }),
                h(c('el-table-column'), { label: '最近联系', width: 120 }, {
                    default: ({ row }) => (row.last ? `${clock(row.last.time)} ${row.last.from === 'user' ? '对方' : '她'}` : '—'),
                }),
                h(c('el-table-column'), { label: '她现在在做什么', minWidth: 220 }, { default: ({ row }) => row.now ?? '—' }),
            ]);
            return h('div', null, [
                h('div', { class: 'qqbot-status-head' }, [
                    h('div', null, [h('h2', { class: 'qqbot-status-title' }, '她现在的状态'), h('p', { class: 'qqbot-muted' }, `每 5 秒自动更新 · ${clock(data.updatedAt)}`)]),
                    h('div', { class: 'qqbot-status-head-tags' }, [tag(status.schedule ? '按作息运行' : '作息未启用', status.schedule ? 'success' : 'warning'), tag(dshFeature?.on ? '外部顾问已启用' : '外部顾问未启用', dshFeature?.on ? 'success' : 'info')]),
                ]),
                kpis, connections, pulse, summary, features, phoneActions, externalPlatforms, extras, contactToolbar, table,
            ]);
        };
    },
});
