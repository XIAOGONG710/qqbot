// 状态页：插件在不在跑、NapCat / Hindsight 连没连上、名单里每人现在在等什么（ADR 0010）。不显示聊天内容。
import { computed, defineComponent, h, ref } from 'vue';
import { store } from '@koishijs/client';
import { c, clock, tag, tierLabel } from './common.js';
import { extrasRows, featureGroups, featureLabel, featureTitle, filterContacts, overviewCounts } from './dashboard.js';

function phaseText(r) {
    switch (r.phase) {
        case 'waiting': return `等到 ${clock(r.seenAt)} 看到（${r.reason}）`;
        case 'settling': return '对方还在发，等他停下';
        case 'generating': return '在生成回复';
        case 'sending': return '在发回复';
        case 'retry': return `回复失败，${clock(r.retryAt)} 再试（连续 ${r.failures} 次）`;
        case 'initiating': return `在主动找对方（${r.reason}）`;
        // 收尾后的附和、看心情不回（ADR 0013）：对方再来一条就清掉
        default: return r.skipped ? `空闲；${clock(r.skipped.at)} 那串没回：${r.skipped.reason}` : '空闲';
    }
}

const PROACTIVE_MODES = { off: ['关', 'info'], dryRun: ['试运行（只写日志不发）', 'warning'], on: ['开', 'success'] };

/** 主动消息（ADR 0011）：下一次几点、什么时机；他没回时先不排；今天主动了几条。不显示内容 */
function proactiveText(p) {
    if (!p) return '—';
    const parts = [];
    if (p.paused) parts.push(p.paused);
    parts.push(p.next ? `下一次 ${clock(p.next.at)} ${p.next.label}` : '今明两天没有要发的');
    parts.push(`今天已主动 ${p.today} 条${p.mode === 'dryRun' ? '（试运行）' : ''}`);
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
    else parts.push(tag('连不上', 'danger'), h('span', { class: 'qqbot-muted' }, ` ${memory.health.error}`));
    const event = (label, e) => e && h('span', { class: 'qqbot-muted' }, ` · ${label} ${clock(e.at)} ${e.ok ? '成功' : `失败：${e.error}`}`);
    parts.push(event('最近一次写入', memory.lastWrite), event('最近一次召回', memory.lastRecall));
    return parts.filter(Boolean);
}

function weatherLine(weather) {
    if (!weather) return [tag('未开启', 'info')];
    const places = Object.values(weather.places ?? {});
    const errors = places.filter(place => place.error).length;
    const hours = places.reduce((sum, place) => sum + (place.hours ?? 0), 0);
    return [
        tag(errors ? `${errors} 个地点失败` : '正常', errors ? 'warning' : 'success'),
        h('span', { class: 'qqbot-muted' }, ` ${hours} 个小时缓存${weather.fetchedAt ? ` · 最近 ${clock(weather.fetchedAt)}` : ''}`),
    ];
}

function mobileCompanionLine(companion) {
    if (!companion?.enabled) return [tag('未开启', 'info')];
    if (!companion.pairedClientId) return [tag('已开启，等待配对', 'warning'), h('span', { class: 'qqbot-muted' }, ` 队列 ${companion.queued}/${companion.maxQueuedPerClient}`)];
    return [tag(companion.connected ? '已连接' : '已配对，等待重连', companion.connected ? 'success' : 'warning'), h('span', { class: 'qqbot-muted' }, ` ${companion.pairedClientId} · 队列 ${companion.queued}/${companion.maxQueuedPerClient}`)];
}

/** 功能开关（ADR 0120）：按模块分组，开着的亮绿色、关着的灰色；鼠标放上去看 ADR 编号。页面文件是从仓库直接读的：插件还是旧代码（没重启）时状态里没有 features */
function featurePanel(status) {
    if (!status.features) return h('p', { class: 'qqbot-muted' }, '功能开关：重启 Koishi 后显示');
    const { on, total } = featureTotals(status.features);
    return h('details', { class: 'qqbot-features-disclosure', open: true }, [
        h('summary', { class: 'qqbot-features-summary' }, `功能开关　已开 ${on} / ${total}`),
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
        status.extras?.report ? h('pre', { class: 'qqbot-report' }, status.extras.report.text) : null,
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
            const runtime = status?.runtime;
            const counts = overviewCounts(status);
            const dshFeature = status?.features?.find(feature => feature.key === 'dsh');
            const rows = [
                ['插件', data.running
                    ? [tag('在回复', 'success')]
                    : [tag('没在运行', 'danger'), data.error ? h('span', { class: 'qqbot-error' }, ` ${data.error}`) : h('span', { class: 'qqbot-muted' }, ' 看插件配置页的运行日志')]],
                ['NapCat', data.napcat?.online ? [tag('已连上', 'success'), h('span', { class: 'qqbot-muted' }, ` 小号 ${data.napcat.selfId ?? ''}`)] : [tag('没连上', 'danger')]],
                ['运行版本', runtime
                    ? [runtime.dirty === null ? tag('工作树未知', 'warning') : tag(runtime.dirty ? '有未提交改动' : '干净', runtime.dirty ? 'danger' : 'success'), h('span', { class: 'qqbot-muted' }, ` ${runtime.branch} · ${runtime.commit.slice(0, 12)} · ${clock(runtime.startedAt)} 启动`)]
                    : [tag('重启 Koishi 后显示', 'info')]],
                ['长期记忆', status ? memoryLine(status.memory) : [tag('—', 'info')]],
                ['实时天气', status ? weatherLine(status.weather) : [tag('—', 'info')]],
                ['手机伴侣', status ? mobileCompanionLine(status.mobileCompanion) : [tag('—', 'info')]],
                ['作息', status ? [status.schedule ? tag('按作息', 'success') : tag('关（随时几秒内回）', 'warning')] : [tag('—', 'info')]],
                ['看心情不回', status ? [status.moody && status.schedule ? tag('开（偶尔不回「哈哈」「嗯」）', 'success') : tag('关', 'info')] : [tag('—', 'info')]],
                ['今天', status ? todayLine(status) : [tag('—', 'info')]],
                ['说话的毛病', status ? [status.speechCheck === false ? tag('不查', 'info') : tag('查（助手腔、算账、怪对方没说、重复）', 'success')] : [tag('—', 'info')]],
                ['名单外的好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
                ['主动消息', status ? [tag(...(PROACTIVE_MODES[status.proactive ?? 'off'] ?? [status.proactive, 'info']))] : [tag('—', 'info')]],
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const kpis = h('div', { class: 'qqbot-kpis' }, [
                overviewCard('联系人', counts.contacts, `${counts.busy} 个正在处理`, counts.busy ? 'warning' : 'success'),
                overviewCard('功能开关', `${counts.features.on}/${counts.features.total}`, '当前实例已启用', counts.features.on ? 'success' : 'info'),
                overviewCard('DSH 顾问', counts.dshOn ? '已开启' : '已关闭', counts.dshOn ? '仅显式 /dsh 命令调用' : '不会发送 DSH 请求', counts.dshOn ? 'success' : 'info'),
                overviewCard('重试中', counts.retrying, counts.retrying ? '请查看联系人详情' : '当前没有失败重试', counts.retrying ? 'danger' : 'success'),
            ]);
            const connections = h('div', { class: 'qqbot-connections' }, [
                connectionCard('插件', data.running, data.running ? '正在运行' : (data.error ?? '未运行')),
                connectionCard('NapCat', data.napcat?.online === true, data.napcat?.selfId ? `小号 ${data.napcat.selfId}` : '等待连接'),
                connectionCard('长期记忆', Boolean(status.memory?.health?.ok), status.memory ? (status.memory.health?.ok ? '服务正常' : '检查中或不可用') : '功能未开启'),
                connectionCard('实时天气', Boolean(status.weather?.fetchedAt), status.weather?.fetchedAt ? `最近 ${clock(status.weather.fetchedAt)}` : '尚未取数'),
                connectionCard('DSH', dshFeature?.on === true, dshFeature?.on ? '显式咨询可用' : '开关关闭'),
                connectionCard('手机伴侣', status.mobileCompanion?.enabled === true && status.mobileCompanion.connected === true, status.mobileCompanion?.enabled ? (status.mobileCompanion.pairedClientId ? (status.mobileCompanion.connected ? `已连接 · 队列 ${status.mobileCompanion.queued}/${status.mobileCompanion.maxQueuedPerClient}` : `已配对，等待重连 · 队列 ${status.mobileCompanion.queued}/${status.mobileCompanion.maxQueuedPerClient}`) : '已开启，等待一次性配对') : '开关关闭'),
            ]);
            const features = featurePanel(status);
            const extras = extrasPanel(status);
            const contactToolbar = h('div', { class: 'qqbot-contact-toolbar' }, [
                h('div', { class: 'qqbot-section-title' }, [h('strong', null, '联系人'), h('span', { class: 'qqbot-muted' }, `显示 ${filteredContacts.value.length}/${counts.contacts}`)]),
                h(c('el-input'), {
                    modelValue: query.value, 'onUpdate:modelValue': value => { query.value = value; },
                    clearable: true, placeholder: '搜索称呼、QQ、档位或当前状态', class: 'qqbot-contact-search',
                }),
                h(c('el-checkbox'), { modelValue: activeOnly.value, 'onUpdate:modelValue': value => { activeOnly.value = value; } }, () => '只看忙碌'),
            ]);
            const table = h(c('el-table'), { data: filteredContacts.value, border: true, stripe: true, size: 'small', emptyText: query.value || activeOnly.value ? '没有符合条件的联系人' : '暂无联系人', style: 'width: 100%; margin-top: 10px' }, () => [
                h(c('el-table-column'), { label: '称呼', prop: 'name', width: 120 }),
                h(c('el-table-column'), { label: 'QQ', prop: 'qq', width: 120 }),
                h(c('el-table-column'), { label: '档位', width: 130 }, {
                    // 换档或者归档测试数据（ADR 0011 第 10 节）时记下的起点：之前的聊天记录不再用
                    default: ({ row }) => [tierLabel(row.tier), row.tierSince ? h('div', { class: 'qqbot-muted' }, `记录从 ${clock(row.tierSince)} 起`) : null],
                }),
                h(c('el-table-column'), { label: '现在', minWidth: 220 }, { default: ({ row }) => phaseText(row.responder) }),
                h(c('el-table-column'), { label: '主动', minWidth: 240 }, { default: ({ row }) => proactiveText(row.proactive) }),
                h(c('el-table-column'), { label: '最后一条', width: 150 }, {
                    default: ({ row }) => (row.last ? `${clock(row.last.time)} ${row.last.from === 'user' ? '对方' : '她'}` : '—'),
                }),
                h(c('el-table-column'), { label: '她此刻（这一档看到的作息）', minWidth: 260 }, { default: ({ row }) => row.now ?? '—' }),
            ]);
            return h('div', null, [
                h('div', { class: 'qqbot-status-head' }, [
                    h('div', null, [h('h2', { class: 'qqbot-status-title' }, '运行总览'), h('p', { class: 'qqbot-muted' }, `状态每 5 秒自动刷新 · 最近更新 ${clock(data.updatedAt)}`)]),
                    h('div', { class: 'qqbot-status-head-tags' }, [tag(status.schedule ? '按作息运行' : '不按作息', status.schedule ? 'success' : 'warning'), tag(dshFeature?.on ? 'DSH 已开启' : 'DSH 已关闭', dshFeature?.on ? 'success' : 'info')]),
                ]),
                kpis, connections, summary, features, extras, contactToolbar, table,
            ]);
        };
    },
});
