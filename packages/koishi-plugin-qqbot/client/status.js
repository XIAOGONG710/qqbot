// 状态页：插件在不在跑、NapCat / Hindsight 连没连上、名单里每人现在在等什么（ADR 0010）。不显示聊天内容。
import { defineComponent, h } from 'vue';
import { store } from '@koishijs/client';
import { c, clock, tag, tierLabel } from './common.js';

function phaseText(r) {
    switch (r.phase) {
        case 'waiting': return `等到 ${clock(r.seenAt)} 看到（${r.reason}）`;
        case 'settling': return '对方还在发，等他停下';
        case 'generating': return '在生成回复';
        case 'sending': return '在发回复';
        case 'retry': return `回复失败，${clock(r.retryAt)} 再试（连续 ${r.failures} 次）`;
        default: return '空闲';
    }
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

export const StatusTab = defineComponent({
    setup() {
        return () => {
            const data = store.qqbot;
            if (!data) return h('p', null, '正在读取……');
            const status = data.status;
            const rows = [
                ['插件', data.running
                    ? [tag('在回复', 'success')]
                    : [tag('没在运行', 'danger'), data.error ? h('span', { class: 'qqbot-error' }, ` ${data.error}`) : h('span', { class: 'qqbot-muted' }, ' 看插件配置页的运行日志')]],
                ['NapCat', data.napcat?.online ? [tag('已连上', 'success'), h('span', { class: 'qqbot-muted' }, ` 小号 ${data.napcat.selfId ?? ''}`)] : [tag('没连上', 'danger')]],
                ['长期记忆', status ? memoryLine(status.memory) : [tag('—', 'info')]],
                ['作息', status ? [status.schedule ? tag('按作息', 'success') : tag('关（随时几秒内回）', 'warning')] : [tag('—', 'info')]],
                ['名单外的好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const table = h(c('el-table'), { data: status.contacts, border: true, style: 'width: 100%; margin-top: 16px' }, () => [
                h(c('el-table-column'), { label: '称呼', prop: 'name', width: 120 }),
                h(c('el-table-column'), { label: 'QQ', prop: 'qq', width: 120 }),
                h(c('el-table-column'), { label: '档位', width: 130 }, {
                    default: ({ row }) => [tierLabel(row.tier), row.tierSince ? h('div', { class: 'qqbot-muted' }, `${clock(row.tierSince)} 换档`) : null],
                }),
                h(c('el-table-column'), { label: '现在', minWidth: 220 }, { default: ({ row }) => phaseText(row.responder) }),
                h(c('el-table-column'), { label: '最后一条', width: 150 }, {
                    default: ({ row }) => (row.last ? `${clock(row.last.time)} ${row.last.from === 'user' ? '对方' : '她'}` : '—'),
                }),
                h(c('el-table-column'), { label: '她此刻（这一档看到的作息）', minWidth: 260 }, { default: ({ row }) => row.now ?? '—' }),
            ]);
            return h('div', null, [summary, table]);
        };
    },
});
