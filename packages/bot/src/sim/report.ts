// 把一次运行写成 Markdown 报告：每一步的虚拟时间、对方说的、她发的、调度事件、提示词里的动态部分、检查结果。

import type { RunResult, StepRecord } from './runner.ts';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`; };
const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n');

/** 调度相关的日志（不含每次都有的「收到」「已回复」） */
const SCHEDULING = /\d{2}:\d{2}:\d{2} 看到|吵醒|已经收尾|等了一天|出口检查|生成期间收到新消息|发送中途对方插话|插话没有触发|模型回复清理后为空|回复失败|召回失败|记忆写入失败|连接失败|Hindsight 后台任务|关系概况刷新|删除测试 bank|^主动|待跟进/;

export function renderReport(result: RunResult): string {
    const { scenario } = result;
    const lines: string[] = [
        `# ${scenario.name}（${result.runId}）`,
        '',
        ...(scenario.description ? [scenario.description, ''] : []),
        `档位 ${scenario.tier} · 称呼 ${scenario.user} · 起点 ${day(Date.parse(scenario.start))} ${clock(Date.parse(scenario.start))}` +
            ` · 记忆 ${result.bankId ?? '未用'} · 检查 ${result.checks.passed} 通过 / ${result.checks.failed} 不通过`,
        '',
    ];
    let lastDay = '';
    // 按每条消息自己的日子换天（advance 这一步的 time 是拨完之后的时刻，途中发的消息可能在前几天）
    const dayPrefix = (time: number) => {
        const d = day(time);
        const show = d !== lastDay;
        lastDay = d;
        return show ? `${d} ` : '';
    };
    for (const step of result.steps) lines.push(...renderStep(step, dayPrefix));
    return lines.join('\n') + '\n';
}

function renderStep(step: StepRecord, dayPrefix: (time: number) => string): string[] {
    const out: string[] = [];
    // 有对话内容的步骤：say，以及等待期间她回了话的 wait、advance
    const exchange = step.kind === 'say' || step.bubbles.length > 0;
    switch (step.kind) {
        case 'case':
            out.push(`## ${step.caseId}${step.note ? ` ${step.note}` : ''}`, '');
            break;
        case 'advance':
            out.push(`*（时间往后跳 ${step.advance}，到 ${day(step.time)} ${clock(step.time)}）*`, '');
            if (exchange) out.push(...renderExchange(step, dayPrefix));
            break;
        case 'wait':
            out.push('*（时间往后走，等她回复）*', '');
            if (exchange) out.push(...renderExchange(step, dayPrefix));
            break;
        case 'memory':
            out.push('*（把结束了的片段写进记忆）*', '');
            break;
        case 'refresh':
            out.push('**关系概况（手动刷新后）**', '', step.relationship ? quote(step.relationship) : '（空）', '');
            break;
        case 'forget':
            out.push('*（聊天记录挪走，之后只能靠记忆）*', '');
            break;
        case 'hindsight':
            out.push(`*（Hindsight ${step.logs.some(l => l.includes('停了')) ? '停了' : '恢复'}）*`, '');
            break;
        case 'check':
            for (const c of step.checks) out.push(`- ${c.ok ? '✅' : '❌'} ${c.text}`);
            out.push('');
            return out;
        case 'say':
            out.push(...renderExchange(step, dayPrefix));
            break;
    }
    for (const l of step.logs.filter(l => SCHEDULING.test(l) && !exchange)) out.push(`- ${l}`);
    if (!exchange && step.logs.some(l => SCHEDULING.test(l))) out.push('');
    return out;
}

/** 对方的消息、她的回复、调度日志、没原样发出的原文、提示词的动态部分 */
function renderExchange(step: StepRecord, dayPrefix: (time: number) => string): string[] {
    const out: string[] = [];
    // 对方的消息和她的回复按时间排在一起
    const events = [
        ...step.inputs.map(i => ({ time: i.time, text: `**对方**${i.interrupt ? '（插话）' : ''}：${i.text}` })),
        ...step.bubbles.map(b => ({ time: b.time, text: `她${b.proactive ? `（主动：${b.proactive}）` : ''}：${b.text}` })),
    ].sort((a, b) => a.time - b.time);
    for (const e of events) out.push(`- \`${dayPrefix(e.time)}${clock(e.time)}\` ${e.text}`);
    const scheduling = step.logs.filter(l => SCHEDULING.test(l));
    out.push('', `生成 ${step.generations.length} 次${scheduling.length ? `；${scheduling.join('；')}` : ''}`, '');
    // 被清理掉或者没发出去的模型原文（例如清理后为空、被插话丢掉的草稿）
    const sent = step.bubbles.map(b => b.text).join('\n');
    const unsent = step.generations.filter(g => g.raw !== undefined && !sent.includes(g.raw.trim().split('\n')[0]!.trim()));
    for (const g of unsent) out.push('模型原文（没有原样发出）：', '', '```text', ...g.raw!.split('\n'), '```', '');
    for (const g of step.generations) for (const r of g.rewrites ?? []) out.push('出口检查重写的原文：', '', '```text', ...r.split('\n'), '```', '');
    const last = step.generations.at(-1);
    if (last) {
        const parts = [last.timeBlock, last.recall, last.relationship].filter(Boolean) as string[];
        out.push('<details><summary>提示词里的动态部分（最后一次生成）</summary>', '', '```text', ...parts.join('\n\n').split('\n'), '```', '', '</details>', '');
    }
    return out;
}
