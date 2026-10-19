// 把一次运行写成 Markdown 报告：每一步的虚拟时间、对方说的、她发的、调度事件、提示词里的动态部分、检查结果。

import { EMPTIED, type RunResult, type StepRecord } from './runner.ts';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`; };
const quote = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n');

/** 调度相关的日志（不含每次都有的「收到」「已回复」） */
const SCHEDULING = /\d{2}:\d{2}:\d{2} 看到|吵醒|已经收尾|等了一天|出口检查|生成期间收到新消息|发送中途对方插话|插话没有触发|模型回复清理后为空|回复失败|召回失败|记忆写入失败|连接失败|Hindsight 后台任务|关系概况刷新|删除测试 bank|^主动|待跟进|上下文要点/;

/** 「回复 39 通过 / 2 不通过 · 管线自检 12 / 12」：管线自检（提示词里有没有那一行）不算进回复的通过率 */
export function checkSummary(checks: RunResult['checks']): string {
    const reply = `${checks.reply.passed} 通过 / ${checks.reply.failed} 不通过`;
    const pipeline = checks.pipeline.passed + checks.pipeline.failed;
    return pipeline ? `回复 ${reply} · 管线自检 ${checks.pipeline.passed} / ${pipeline}` : reply;
}

/**
 * 出口检查介入了几次（DSH 复核 ADR 0036 P1-4）：发出去的话是清理过的，「出口检查干净」近似自证；
 * 重写、删行的次数单列，变多就是模型原文在变差。清理后为空、重新生成的（P1-5）也单列
 */
export function exitStats(result: RunResult): { generations: number; rewrites: number; removed: number; emptied: number } {
    const logs = result.steps.flatMap(step => step.logs);
    return {
        generations: result.steps.reduce((n, step) => n + step.generations.length, 0),
        rewrites: logs.filter(line => /出口检查：.*带说明重写一次/.test(line)).length,
        removed: logs.filter(line => /出口检查：.*(，去掉|删掉这几行|删掉命中的行)/.test(line)).length,
        emptied: logs.filter(line => EMPTIED.test(line)).length,
    };
}

/** 「生成 12 次，出口检查重写 1、删行 0，清理后为空 0」 */
export function exitSummary(result: RunResult): string {
    const { generations, rewrites, removed, emptied } = exitStats(result);
    return `生成 ${generations} 次，出口检查重写 ${rewrites}、删行 ${removed}，清理后为空 ${emptied}`;
}

export function renderReport(result: RunResult): string {
    const { scenario } = result;
    const lines: string[] = [
        `# ${scenario.name}（${result.runId}）`,
        '',
        ...(scenario.description ? [scenario.description, ''] : []),
        `档位 ${scenario.tier} · 称呼 ${scenario.user} · 起点 ${day(Date.parse(scenario.start))} ${clock(Date.parse(scenario.start))}` +
            ` · 记忆 ${result.bankId ?? '未用'}${result.contextTurns ? `（原文最近 ${result.contextTurns.turns} 轮 + 要点）` : ''} · 检查 ${checkSummary(result.checks)} · ${exitSummary(result)}`,
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
        case 'video':
            out.push('*（她刷到一个 B 站视频、想发给他）*', '');
            if (exchange) out.push(...renderExchange(step, dayPrefix));
            break;
        case 'life':
            out.push(`*（生活事件 ${step.life ?? '未记录'}）*`, '');
            break;
        case 'action':
            out.push(`*（类型化行动 ${step.action ?? '未安排'}）*`, '');
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
        case 'restart':
            out.push('*（bot 重启，从数据目录重新读起）*', '');
            if (exchange) out.push(...renderExchange(step, dayPrefix));
            break;
        case 'check':
            for (const c of step.checks) out.push(`- ${c.ok ? '✅' : '❌'} ${c.pipeline ? '〔管线〕' : ''}${c.text}`);
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
    // 一条气泡里合并了几行（reply.ts packLines）时用 ⏎ 标出来，不然 Markdown 把第二行接在上一行后面，看不出她说了几句
    const events = [
        ...step.inputs.map(i => ({ time: i.time, text: `**对方**${i.interrupt ? '（插话）' : ''}：${i.text}` })),
        ...step.bubbles.map(b => ({ time: b.time, text: `她${b.proactive ? `（主动：${b.proactive}）` : ''}：${b.text.replaceAll('\n', ' ⏎ ')}` })),
    ].sort((a, b) => a.time - b.time);
    for (const e of events) out.push(`- \`${dayPrefix(e.time)}${clock(e.time)}\` ${e.text}`);
    const scheduling = step.logs.filter(l => SCHEDULING.test(l));
    const size = step.generations.at(-1)?.tokens;
    out.push('', `生成 ${step.generations.length} 次${size ? `（提示词约 ${size} token）` : ''}${scheduling.length ? `；${scheduling.join('；')}` : ''}`, '');
    // 被清理掉或者没发出去的模型原文（例如清理后为空、被插话丢掉的草稿）
    const sent = step.bubbles.map(b => b.text).join('\n');
    const unsent = step.generations.filter(g => g.raw !== undefined && !sent.includes(g.raw.trim().split('\n')[0]!.trim()));
    for (const g of unsent) out.push('模型原文（没有原样发出）：', '', '```text', ...g.raw!.split('\n'), '```', '');
    for (const g of step.generations) for (const r of g.rewrites ?? []) out.push('出口检查重写的原文：', '', '```text', ...r.split('\n'), '```', '');
    const last = step.generations.at(-1);
    if (last) {
        // 想起的从前只写标题：年表和块里有真实住址（作者 10-07：住址不进模拟器报告）
        const past = last.past ? `[你想起的从前：${[...last.past.matchAll(/^- ([^：\n]+)：/gm)].map(m => m[1]).join('、')}（正文和年表略）]` : undefined;
        const parts = [last.timeBlock, last.summary, last.recall, last.common, last.todayOthers, past, last.people, last.relationship].filter(Boolean) as string[];
        out.push('<details><summary>提示词里的动态部分（最后一次生成）</summary>', '', '```text', ...parts.join('\n\n').split('\n'), '```', '', '</details>', '');
    }
    return out;
}
