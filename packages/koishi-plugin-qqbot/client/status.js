// 状态页：插件在不在跑、NapCat / Hindsight 连没连上、名单里每人现在在等什么（ADR 0010）。不显示聊天内容。
import { computed, defineComponent, h, ref } from 'vue';
import { store } from '@koishijs/client';
import { c, clock, tag, tierLabel } from './common.js';
import { extrasRows, featureGroups, featureLabel, featureTitle, featureTotals, filterContacts, overviewCounts, timeZoneLine } from './dashboard.js';

function phaseText(r) {
    switch (r.phase) {
        case 'waiting': return '等对方停下来';
        case 'settling': return '对方还在发消息';
        case 'generating': return '正在准备回复';
        case 'sending': return '正在发送回复';
        case 'retry': return '回复遇到问题，稍后再试';
        case 'initiating': return '正在主动联系';
        // 收尾后的附和、看心情不回：对方再来一条就清掉
        default: return r.skipped ? '暂时不回复' : '空闲';
    }
}

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

/** 她自己的日子（ADR 0015）：今天的心情和原因、每本书的进度 */
function todayLine(status) {
    // 页面文件是从仓库直接读的：插件还是旧代码（没重启）时状态里没有这一项
    if (status.herDays === undefined) return [tag('重启 Koishi 后才有', 'info')];
    if (status.herDays === false) return [tag('关', 'info')];
    const today = status.today;
    if (!today) return [tag('卡上没有心情和书', 'info')];
    const books = today.books.map(book => `《${book.title}》${book.finished ? '读完了' : `第 ${book.amount} ${book.unit}${book.putDown ? '（放下了）' : book.stopped ? '（先停在这）' : ''}`}`).join('、');
    return [
        today.mood ? tag(today.mood.name, 'success') : tag('没有心情', 'info'),
        h('span', { class: 'qqbot-muted' }, ` ${today.mood ? today.mood.reason : ''}${books ? `；在读 ${books}` : ''}（${today.day.slice(5)}）`),
    ];
}

function memoryLine(memory) {
    if (!memory) return [tag('没开', 'info')];
    const parts = [];
    if (!memory.health) parts.push(tag('检查中', 'info'));
    else if (memory.health.ok) parts.push(tag('连得上', 'success'));
    else parts.push(tag('连不上', 'danger'), h('span', { class: 'qqbot-muted' }, ' 请检查记忆服务设置'));
    const event = (label, e) => e && h('span', { class: 'qqbot-muted' }, ` · ${label} ${clock(e.at)} ${e.ok ? `成功${e.items === undefined ? '' : `（${e.items} 条）`}` : '失败，请稍后重试'}`);
    parts.push(event('最近一次写入', memory.lastWrite), event('最近一次召回', memory.lastRecall));
    if (!memory.lastWrite && !memory.lastRecall) parts.push(h('span', { class: 'qqbot-muted' }, ' · 等待第一次同步'));
    return parts.filter(Boolean);
}

function weatherLine(weather) {
    if (!weather) return [tag('未开启', 'info')];
    const places = Object.values(weather.places ?? {});
    const errors = places.filter(place => place.error).length;
    const stale = places.filter(place => place.stale).length;
    const hours = places.reduce((sum, place) => sum + (place.hours ?? 0), 0);
    const lastErrorAt = places.map(place => place.errorAt).filter(Boolean).sort().at(-1);
    return [
        tag(errors ? `${errors} 个地点失败` : stale ? `${stale} 个地点陈旧` : '正常', errors || stale ? 'warning' : 'success'),
        h('span', { class: 'qqbot-muted' }, ` 已缓存 ${hours} 小时${weather.fetchedAt ? ` · 最近更新 ${clock(weather.fetchedAt)}` : ''}${lastErrorAt ? ` · 最近失败 ${clock(lastErrorAt)}` : ''}`),
    ];
}

function humanValuesLine(values) {
    if (!values) return [tag('自主生活未开启', 'info')];
    const positiveLevel = value => value >= 75 ? 'success' : value <= 25 ? 'danger' : 'warning';
    const loadLevel = value => value >= 75 ? 'danger' : value <= 25 ? 'success' : 'warning';
    return [
        tag(`精力 ${values.energy}`, positiveLevel(values.energy)),
        tag(`饥饿 ${values.hunger}`, loadLevel(values.hunger)),
        tag(`压力 ${values.stress}`, loadLevel(values.stress)),
        h('span', { class: 'qqbot-muted' }, ` 心情 ${values.mood} · 健康 ${values.health} · 动机 ${values.motivation} · 孤独 ${values.loneliness}`),
    ];
}

function mobileCompanionLine(companion) {
    if (!companion?.enabled) return [tag('未开启', 'info')];
    if (!companion.pairedClientId) return [tag('已开启，等待配对', 'warning'), h('span', { class: 'qqbot-muted' }, ` 待发送 ${companion.queued} 条`)];
    return [tag(companion.connected ? '已连接' : '已配对，等待重连', companion.connected ? 'success' : 'warning'), h('span', { class: 'qqbot-muted' }, ` 待发送 ${companion.queued} 条`)];
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

function externalPlatformsPanel(platforms) {
    if (!platforms) return null;
    const labels = { tieba: '百度贴吧', douyin: '抖音', xiaohongshu: '小红书' };
    const modes = {
        off: ['未启用', 'info'],
        draft: ['只生成草稿', 'warning'],
        authorized: ['授权模式，等待官方适配器', 'warning'],
    };
    return h('details', { class: 'qqbot-features-disclosure', open: false }, [
        h('summary', { class: 'qqbot-features-summary' }, '外部平台接入'),
        h('div', { class: 'qqbot-summary' }, Object.entries(labels).map(([key, label]) => {
            const [text, type] = modes[platforms[key] ?? 'off'] ?? modes.off;
            return h('div', { class: 'qqbot-summary-row' }, [h('span', { class: 'qqbot-label' }, label), tag(text, type)]);
        })),
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
            const rows = [
                ['插件', data.running
                    ? [tag('运行正常', 'success')]
                    : [tag('未运行', 'danger'), h('span', { class: 'qqbot-muted' }, ' 请查看插件设置和日志')]],
                ['QQ 连接', data.napcat?.online ? [tag('已连接', 'success')] : [tag('未连接', 'danger')]],
                ['长期记忆', status ? memoryLine(status.memory) : [tag('—', 'info')]],
                ['天气', status ? weatherLine(status.weather) : [tag('—', 'info')]],
                ['她的状态', status ? humanValuesLine(status.humanValues) : [tag('—', 'info')]],
                ['手机伴侣', status ? mobileCompanionLine(status.mobileCompanion) : [tag('—', 'info')]],
                ['作息', status ? [status.schedule ? tag('按作息运行', 'success') : tag('未启用', 'warning')] : [tag('—', 'info')]],
                // 页面文件是从仓库直接读的：插件还是旧代码（没重启）时状态里没有时区这一项
                ['她的时区', status ? (timeZoneLine(status.timeZone, data.updatedAt) ? [h('span', null, timeZoneLine(status.timeZone, data.updatedAt))] : [tag('重启 Koishi 后才有', 'info')]) : [tag('—', 'info')]],
                ['按心情回复', status ? [status.moody && status.schedule ? tag('已启用', 'success') : tag('未启用', 'info')] : [tag('—', 'info')]],
                ['今天', status ? todayLine(status) : [tag('—', 'info')]],
                ['说话检查', status ? [status.speechCheck === false ? tag('未启用', 'info') : tag('已启用', 'success')] : [tag('—', 'info')]],
                ['陌生好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
                ['主动联系', status ? [tag(...(PROACTIVE_MODES[status.proactive ?? 'off'] ?? ['未启用', 'info']))] : [tag('—', 'info')]],
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const kpis = h('div', { class: 'qqbot-kpis' }, [
                overviewCard('联系人', counts.contacts, `${counts.busy} 个正在处理`, counts.busy ? 'warning' : 'success'),
                overviewCard('功能开关', `${counts.features.on}/${counts.features.total}`, '当前实例已启用', counts.features.on ? 'success' : 'info'),
                overviewCard('外部顾问', counts.dshOn ? '已开启' : '已关闭', counts.dshOn ? '可以按需咨询' : '暂未启用', counts.dshOn ? 'success' : 'info'),
                overviewCard('待处理', counts.retrying, counts.retrying ? '有回复需要重试' : '当前没有待处理事项', counts.retrying ? 'danger' : 'success'),
            ]);
            const connections = h('div', { class: 'qqbot-connections' }, [
                connectionCard('插件', data.running, data.running ? '正在运行' : '请查看设置和日志'),
                connectionCard('QQ 连接', data.napcat?.online === true, data.napcat?.online ? '消息通道正常' : '等待连接'),
                connectionCard('长期记忆', Boolean(status.memory?.health?.ok), status.memory ? (status.memory.health?.ok ? '服务正常' : '检查中或不可用') : '功能未开启'),
                connectionCard('天气', Boolean(status.weather?.fetchedAt), status.weather?.fetchedAt ? '数据正常' : '尚未取数'),
                connectionCard('外部顾问', dshFeature?.on === true, dshFeature?.on ? '可以按需咨询' : '暂未启用'),
                connectionCard('手机伴侣', status.mobileCompanion?.enabled === true && status.mobileCompanion.connected === true, status.mobileCompanion?.enabled ? (status.mobileCompanion.pairedClientId ? (status.mobileCompanion.connected ? '已连接' : '等待重连') : '等待配对') : '暂未启用'),
            ]);
            const features = featurePanel(status);
            const extras = extrasPanel(status);
            const phoneActions = phoneActionsPanel(data.phoneActions);
            const externalPlatforms = externalPlatformsPanel(status.externalPlatforms);
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
                h(c('el-table-column'), { label: '当前状态', minWidth: 180 }, { default: ({ row }) => phaseText(row.responder) }),
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
                kpis, connections, summary, features, phoneActions, externalPlatforms, extras, contactToolbar, table,
            ]);
        };
    },
});
