// 把一次运行写成 Markdown 报告：每一步的虚拟时间、对方说的、她发的、调度事件、提示词里的动态部分、检查结果。

import type { RunResult, StepRecord } from './runner.ts';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`; };
const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n');

/** 调度相关的日志（不含每次都有的「收到」「已回复」） */
const SCHEDULING = /生成期间收到新消息|发送中途对方插话|插话没有触发|模型回复清理后为空|回复失败|召回失败|记忆写入失败|连接失败|Hindsight 后台任务|删除测试 bank/;

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
    for (const step of result.steps) {
        lines.push(...renderStep(step, () => {
            const d = day(step.time);
            const show = d !== lastDay;
            lastDay = d;
            return show ? `${d} ` : '';
        }));
    }
    return lines.join('\n') + '\n';
}

function renderStep(step: StepRecord, dayPrefix: () => string): string[] {
    const out: string[] = [];
    switch (step.kind) {
        case 'case':
            out.push(`## ${step.caseId}${step.note ? ` ${step.note}` : ''}`, '');
            break;
        case 'advance':
            out.push(`*（时间往后跳 ${step.advance}，现在 ${day(step.time)} ${clock(step.time)} 之后）*`, '');
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
        case 'say': {
            // 对方的消息和她的回复按时间排在一起
            const events = [
                ...step.inputs.map(i => ({ time: i.time, text: `**对方**${i.interrupt ? '（插话）' : ''}：${i.text}` })),
                ...step.bubbles.map(b => ({ time: b.time, text: `她：${b.text}` })),
            ].sort((a, b) => a.time - b.time);
            for (const e of events) out.push(`- \`${dayPrefix()}${clock(e.time)}\` ${e.text}`);
            const scheduling = step.logs.filter(l => SCHEDULING.test(l));
            out.push('', `生成 ${step.generations.length} 次${scheduling.length ? `；${scheduling.join('；')}` : ''}`, '');
            // 被清理掉或者没发出去的模型原文（例如清理后为空、被插话丢掉的草稿）
            const sent = step.bubbles.map(b => b.text).join('\n');
            const unsent = step.generations.filter(g => g.raw !== undefined && !sent.includes(g.raw.trim().split('\n')[0]!.trim()));
            for (const g of unsent) out.push('模型原文（没有原样发出）：', '', '```text', ...g.raw!.split('\n'), '```', '');
            const last = step.generations.at(-1);
            if (last) {
                const parts = [last.timeBlock, last.recall, last.relationship].filter(Boolean) as string[];
                out.push('<details><summary>提示词里的动态部分（最后一次生成）</summary>', '', '```text', ...parts.join('\n\n').split('\n'), '```', '', '</details>', '');
            }
            break;
        }
    }
    for (const l of step.logs.filter(l => SCHEDULING.test(l) && step.kind !== 'say')) out.push(`- ${l}`);
    if (step.kind !== 'say' && step.logs.some(l => SCHEDULING.test(l))) out.push('');
    return out;
}
