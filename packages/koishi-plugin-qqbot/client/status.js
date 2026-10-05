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
                ['看心情不回', status ? [status.moody && status.schedule ? tag('开（偶尔不回「哈哈」「嗯」）', 'success') : tag('关', 'info')] : [tag('—', 'info')]],
                ['说话的毛病', status ? [status.speechCheck === false ? tag('不查', 'info') : tag('查（助手腔、算账、怪对方没说、重复）', 'success')] : [tag('—', 'info')]],
                ['名单外的好友', status ? [status.unlistedFriends ? tag('也回复', 'warning') : tag('不回复', 'info')] : [tag('—', 'info')]],
                ['主动消息', status ? [tag(...(PROACTIVE_MODES[status.proactive ?? 'off'] ?? [status.proactive, 'info']))] : [tag('—', 'info')]],
            ];
            const summary = h('div', { class: 'qqbot-summary' }, rows.map(([label, value]) => h('div', { class: 'qqbot-summary-row' }, [
                h('span', { class: 'qqbot-label' }, label), h('span', null, value),
            ])));
            if (!status) return h('div', null, [summary]);
            const table = h(c('el-table'), { data: status.contacts, border: true, style: 'width: 100%; margin-top: 16px' }, () => [
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
            return h('div', null, [summary, table]);
        };
    },
});
