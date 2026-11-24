// 每周效果数（ADR 0348）：读数据目录里她自己的聊天记录，按天、按周出一组固定口径的数，每跑一次在 <数据目录>/logs/weekly-metrics.jsonl 记一行，
// 下次跑可以和上一次比。为什么：功能一个接一个上线，好不好只能凭某次聊天的感觉；这里给每个新功能一把「它改善的是哪个数」的尺子。
// 只出数：不出任何一句原话、不出完整 QQ 号（只在范围里写后四位）。聊天内容只在内存里用来数长度、跑检测器。
// 检测器全部复用现成的，不另起一套：
//   助手腔   = 出口检查的说话毛病 service（speech-check.ts）∪ 人格自检 assistant_tone（selfcheck.ts）∪ 拟人评测 assistantMeta（companion-eval.ts）
//            ∪ 人格一致性 voiceDrift（personhood-eval.ts）
//   重复     = 出口检查的说话毛病 repeat（开头 / 四字片段 / 原话，和线上同一个判断、同一个上下文）；另报 personhood-eval 的整句重复、近似重复、开头重复
//   叮嘱     = 「学会了」探针的 NAG（sim/learning-probe.ts）；另报出口检查的 nag（同一段聊天里又叮嘱同一类）
//   编造嫌疑 = 出口检查的 promise（做不到的事）、script（替两个人编对话）；他下一条在纠正她（chat-review.ts 的 HE_CORRECTS）
// 注意：线上发出去之前已经过一遍出口检查，命中的大多被重写或删掉了；这里量到的是「漏过去的」，所以绝对值偏低，看的是周与周之间的走向。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChatHistory, type StoredMessage } from '../memory/history.ts';
import { inspectSpeech, speechContext } from '../language/speech-check.ts';
import { inspectReply } from '../language/exit-check.ts';
import { checkReplies } from '../language/selfcheck.ts';
import { HE_CORRECTS } from '../language/chat-review.ts';
import { NOT_SPEECH, dayKey } from '../language/speech-notes.ts';
import { NAG } from '../sim/learning-probe.ts';
import { contentKind } from './daily-report.ts';
import { evaluateCompanion } from './companion-eval.ts';
import { evaluatePersonhood } from './personhood-eval.ts';

/** 她连着发的几条，间隔不超过这么久算同一轮（和周报 ADR 0118 一样） */
export const TURN_GAP_MS = 25_000;
/** 上一条也是她的、隔了这么久以上又开口，算她自己找他（和周报「她先开口」一样） */
export const SELF_START_GAP_MS = 3_600_000;
/** 她这一轮之后，他多久之内的下一条才算是在回应这一轮（看他有没有在纠正她） */
export const CORRECTION_WINDOW_MS = 30 * 60_000;
/** 重放出口检查时，往前给多少条聊天记录当上下文（speechContext 只用最近 8 次回复和这一段聊天） */
const CONTEXT_MESSAGES = 200;

export interface LatencyStats {
    /** 有多少轮是在回他的话（有延迟可算） */
    count: number;
    /** 秒；没有就是 null */
    p50: number | null;
    p90: number | null;
    /** 各档的轮数：≤30 秒、30 秒–2 分钟、2–10 分钟、10–60 分钟、1 小时以上 */
    within30s: number;
    within2m: number;
    within10m: number;
    within1h: number;
    over1h: number;
}

export interface Metrics {
    /** 他发来的条数 */
    hisMessages: number;
    /** 她发出的条数（气泡，含表情、图片） */
    herBubbles: number;
    /** 她的轮数（连着发的算一轮）及其分类：回他的话 / 自己找他 / 隔了一会儿接着自己说 */
    turns: number;
    replyTurns: number;
    proactiveTurns: number;
    followOnTurns: number;
    /** 自己找他 ÷（回他 + 自己找他） */
    proactiveShare: number | null;
    /** 有文字的轮数：下面的长度和各种比例都以它为分母 */
    textTurns: number;
    avgChars: number | null;
    medianChars: number | null;
    avgLines: number | null;
    medianLines: number | null;
    assistantToneRate: number | null;
    repeatRate: number | null;
    duplicateRate: number | null;
    nearDuplicateRate: number | null;
    openingRepeatRate: number | null;
    nagRate: number | null;
    nagRepeatRate: number | null;
    questionEndRate: number | null;
    promiseRate: number | null;
    scriptRate: number | null;
    correctedRate: number | null;
    latency: LatencyStats;
}

export interface DayMetrics extends Metrics { day: string }

export interface WeeklyMetrics {
    /** 统计窗口（本地时间的整天，ISO） */
    from: string;
    to: string;
    /** 'all'，或只看一个联系人时的「qq…后四位」 */
    scope: string;
    contacts: number;
    days: DayMetrics[];
    week: Metrics;
}

/** 写进 weekly-metrics.jsonl 的一行 */
export interface MetricsRun extends WeeklyMetrics {
    version: 1;
    /** 跑的时刻 */
    at: string;
}

/** 一轮的事实。text 只留在内存里给检测器用，任何输出都不带它 */
export interface Turn {
    at: number;
    day: string;
    kind: 'reply' | 'proactive' | 'followOn';
    bubbles: number;
    latencySec?: number;
    /** 没有文字（全是表情、图片）的轮只算轮数和延迟 */
    text?: {
        content: string;
        chars: number;
        lines: number;
        tone: boolean;
        repeat: boolean;
        nag: boolean;
        nagRepeat: boolean;
        questionEnd: boolean;
        promise: boolean;
        script: boolean;
        corrected: boolean;
    };
}

const cp = (text: string) => [...text].length;
/** 不是她说的话：图片、语音、表情、照片 / 表情包占位、私信 / 分享 / 戳一戳这类记录 */
const isSpeech = (content: string) => {
    const text = content.trim();
    return Boolean(text) && contentKind(text) === 'text' && !NOT_SPEECH.test(text)
        && !/^<(?:sticker|photo)/.test(text) && !/^她发了(?:个表情包|张照片)/.test(text);
};
const QUESTION_END = /(?:[？?]|吗)\s*$/;

/** 这一轮有没有助手腔：四个现成检测器任一命中 */
function assistantTone(content: string, serviceHit: boolean): boolean {
    if (serviceHit) return true;
    if (checkReplies({ replies: [content] }).some(finding => finding.rule === 'assistant_tone')) return true;
    if (evaluateCompanion([{ time: new Date(0).toISOString(), role: 'assistant', content }]).assistantMetaRate > 0) return true;
    return evaluatePersonhood([{ at: new Date(0).toISOString(), reply: content }]).voiceDriftRate > 0;
}

/** 一个联系人的聊天记录 → 她的每一轮；给了 range 只留开头落在 [from, to) 里的（窗口之前的聊天仍当上下文，但不跑检测器，省时间） */
export function turnsOf(messages: readonly StoredMessage[], proactiveIds: ReadonlySet<number> = new Set(), range?: { from: number; to: number }): Turn[] {
    const rows = messages
        .map((message, index) => ({ message, index, t: Date.parse(message.time) }))
        .filter(row => Number.isFinite(row.t) && (row.message.role === 'user' || row.message.role === 'assistant') && typeof row.message.content === 'string')
        .sort((a, b) => a.t - b.t || a.index - b.index);
    const history = rows.map(row => row.message);
    const turns: Turn[] = [];
    for (let start = 0; start < rows.length; start++) {
        if (rows[start]!.message.role !== 'assistant') continue;
        let end = start;
        while (end + 1 < rows.length && rows[end + 1]!.message.role === 'assistant' && rows[end + 1]!.t - rows[end]!.t <= TURN_GAP_MS) end++;
        const at = rows[start]!.t;
        if (range && (at < range.from || at >= range.to)) { start = end; continue; }
        const bubbles = history.slice(start, end + 1);
        const previous = start > 0 ? rows[start - 1] : undefined;
        let kind: Turn['kind'];
        let latencySec: number | undefined;
        if (bubbles.some(bubble => bubble.messageId !== undefined && proactiveIds.has(bubble.messageId))) kind = 'proactive';
        else if (!previous) kind = 'proactive';
        else if (previous.message.role === 'user') { kind = 'reply'; latencySec = Math.max(0, Math.round((at - previous.t) / 1000)); }
        else kind = at - previous.t > SELF_START_GAP_MS ? 'proactive' : 'followOn';
        const turn: Turn = { at, day: dayKey(at), kind, bubbles: bubbles.length, ...(latencySec === undefined ? {} : { latencySec }) };
        const spoken = bubbles.map(bubble => bubble.content.trim()).filter(isSpeech);
        if (spoken.length) {
            const content = spoken.join('\n');
            const speech = inspectSpeech(content, speechContext(history.slice(Math.max(0, start - CONTEXT_MESSAGES), start)));
            const exit = inspectReply(content, []);
            const next = rows[end + 1];
            turn.text = {
                content,
                chars: spoken.reduce((sum, line) => sum + cp(line), 0),
                lines: spoken.reduce((sum, line) => sum + line.split('\n').filter(part => part.trim()).length, 0),
                tone: assistantTone(content, speech.some(issue => issue.kind === 'service')),
                repeat: speech.some(issue => issue.kind === 'repeat'),
                nag: spoken.some(line => NAG.test(line)),
                nagRepeat: speech.some(issue => issue.kind === 'nag'),
                questionEnd: QUESTION_END.test(spoken.at(-1)!),
                promise: exit.some(issue => issue.kind === 'promise'),
                script: exit.some(issue => issue.kind === 'script'),
                corrected: Boolean(next && next.message.role === 'user' && next.t - rows[end]!.t <= CORRECTION_WINDOW_MS && HE_CORRECTS.test(next.message.content.trim())),
            };
        }
        turns.push(turn);
        start = end;
    }
    return turns;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));
const rate = (count: number, total: number) => (total ? round(count / total, 4) : null);
const average = (values: readonly number[]) => (values.length ? round(values.reduce((sum, v) => sum + v, 0) / values.length, 1) : null);
const median = (values: readonly number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid]! : round((sorted[mid - 1]! + sorted[mid]!) / 2, 1);
};
/** 取第 p 分位（最近秩，和周报同一个算法） */
const quantile = (values: readonly number[], p: number) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

export function latencyStats(seconds: readonly number[]): LatencyStats {
    return {
        count: seconds.length,
        p50: quantile(seconds, 0.5),
        p90: quantile(seconds, 0.9),
        within30s: seconds.filter(s => s <= 30).length,
        within2m: seconds.filter(s => s > 30 && s <= 120).length,
        within10m: seconds.filter(s => s > 120 && s <= 600).length,
        within1h: seconds.filter(s => s > 600 && s <= 3600).length,
        over1h: seconds.filter(s => s > 3600).length,
    };
}

/** 一组轮 → 一组数 */
export function aggregate(turns: readonly Turn[], hisMessages: number): Metrics {
    const text = turns.flatMap(turn => (turn.text ? [{ ...turn.text, at: turn.at }] : []));
    const count = (pick: (t: NonNullable<Turn['text']>) => boolean) => rate(text.filter(pick).length, text.length);
    const reply = turns.filter(turn => turn.kind === 'reply').length;
    const proactive = turns.filter(turn => turn.kind === 'proactive').length;
    const personhood = evaluatePersonhood(text.map(t => ({ at: new Date(t.at).toISOString(), reply: t.content })));
    const has = text.length > 0;
    return {
        hisMessages,
        herBubbles: turns.reduce((sum, turn) => sum + turn.bubbles, 0),
        turns: turns.length,
        replyTurns: reply,
        proactiveTurns: proactive,
        followOnTurns: turns.filter(turn => turn.kind === 'followOn').length,
        proactiveShare: rate(proactive, reply + proactive),
        textTurns: text.length,
        avgChars: average(text.map(t => t.chars)),
        medianChars: median(text.map(t => t.chars)),
        avgLines: average(text.map(t => t.lines)),
        medianLines: median(text.map(t => t.lines)),
        assistantToneRate: count(t => t.tone),
        repeatRate: count(t => t.repeat),
        duplicateRate: has ? personhood.duplicateRate : null,
        nearDuplicateRate: has ? personhood.nearDuplicateRate : null,
        openingRepeatRate: has ? personhood.openingRepeatRate : null,
        nagRate: count(t => t.nag),
        nagRepeatRate: count(t => t.nagRepeat),
        questionEndRate: count(t => t.questionEnd),
        promiseRate: count(t => t.promise),
        scriptRate: count(t => t.script),
        correctedRate: count(t => t.corrected),
        latency: latencyStats(turns.flatMap(turn => (turn.latencySec === undefined ? [] : [turn.latencySec]))),
    };
}

export interface MetricsInput {
    /** 联系人 QQ → 聊天记录（整份；窗口之前的部分只当重放出口检查的上下文） */
    chats: ReadonlyMap<number, readonly StoredMessage[]>;
    /** 联系人 QQ → 主动消息记录里「发出去了」的 QQ 消息 id */
    proactiveIds?: ReadonlyMap<number, ReadonlySet<number>>;
    /** 窗口 [from, to)，毫秒 */
    from: number;
    to: number;
    scope?: string;
}

/** 算一个窗口的数：每天一行（没聊天的日子也有一行，全是 0 / null），再加整个窗口一行 */
export function computeWeeklyMetrics(input: MetricsInput): WeeklyMetrics {
    const { from, to } = input;
    const inWindow = (t: number) => t >= from && t < to;
    const turns: Turn[] = [];
    const his: number[] = [];
    // 这个窗口里真有聊天的人（有聊天文件、这几天一句没说的不算）
    const active = new Set<number>();
    for (const [qq, messages] of input.chats) {
        turns.push(...turnsOf(messages, input.proactiveIds?.get(qq), { from, to }));
        for (const message of messages) {
            const t = Date.parse(message.time);
            if (inWindow(t)) active.add(qq);
            if (message.role === 'user' && inWindow(t)) his.push(t);
        }
    }
    turns.sort((a, b) => a.at - b.at);
    const days: DayMetrics[] = [];
    for (let cursor = new Date(from); cursor.getTime() < to; cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)) {
        const day = dayKey(cursor.getTime());
        days.push({ day, ...aggregate(turns.filter(turn => turn.day === day), his.filter(t => dayKey(t) === day).length) });
    }
    return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        scope: input.scope ?? 'all',
        contacts: active.size,
        days,
        week: aggregate(turns, his.length),
    };
}

/** 本地日期 YYYY-MM-DD 往前 days 天（含这一天）的整天窗口 */
export function windowOf(until: string, days: number): { from: number; to: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(until);
    if (!match) throw new Error(`日期要写成 YYYY-MM-DD：${until}`);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error(`--days 要是 1–366 的整数：${days}`);
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    return { from: new Date(year, month, day - days + 1).getTime(), to: new Date(year, month, day + 1).getTime() };
}

/** 读数据目录：chats/<QQ>.jsonl（用 ChatHistory 读，撤回的按撤回算）和 proactive/<QQ>[-档位].json 里发出去的消息 id */
export function loadMetricsData(dataDir: string, qq?: number): { chats: Map<number, StoredMessage[]>; proactiveIds: Map<number, Set<number>> } {
    const chatDir = join(dataDir, 'chats');
    if (!existsSync(chatDir)) throw new Error(`数据目录里没有 chats/：${dataDir}`);
    const history = new ChatHistory(dataDir);
    const chats = new Map<number, StoredMessage[]>();
    for (const name of readdirSync(chatDir)) {
        const match = /^(\d+)\.jsonl$/.exec(name);
        if (!match) continue;
        const id = Number(match[1]);
        if (qq !== undefined && id !== qq) continue;
        chats.set(id, history.load(id));
    }
    const proactiveIds = new Map<number, Set<number>>();
    const proactiveDir = join(dataDir, 'proactive');
    if (existsSync(proactiveDir)) {
        for (const name of readdirSync(proactiveDir)) {
            const match = /^(\d+)(?:-[a-z]+)?\.json$/.exec(name);
            if (!match || !chats.has(Number(match[1]))) continue;
            try {
                const state = JSON.parse(readFileSync(join(proactiveDir, name), 'utf8')) as { records?: { result?: unknown; messageIds?: unknown }[] };
                const ids = proactiveIds.get(Number(match[1])) ?? new Set<number>();
                for (const record of Array.isArray(state.records) ? state.records : []) {
                    if (record?.result !== 'sent' || !Array.isArray(record.messageIds)) continue;
                    for (const id of record.messageIds) if (Number.isSafeInteger(id)) ids.add(id as number);
                }
                proactiveIds.set(Number(match[1]), ids);
            } catch { /* 坏文件当没有：主动轮退回按间隔判断 */ }
        }
    }
    return { chats, proactiveIds };
}

export const metricsLogPath = (dataDir: string) => join(dataDir, 'logs', 'weekly-metrics.jsonl');

/** 日志里同一个范围的最近一次（没有就 undefined）；坏行跳过 */
export function previousRun(path: string, scope: string): MetricsRun | undefined {
    if (!existsSync(path)) return undefined;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const run = JSON.parse(lines[i]!) as MetricsRun;
            if (run?.version === 1 && run.scope === scope && run.week && typeof run.week === 'object') return run;
        } catch { /* 坏行跳过 */ }
    }
    return undefined;
}

export function appendRun(path: string, metrics: WeeklyMetrics, now = new Date()): MetricsRun {
    const run: MetricsRun = { version: 1, at: now.toISOString(), ...metrics };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(run)}\n`, 'utf8');
    return run;
}

/** 参与比较的数（扁平的名字；latency.p50 这种是嵌套的） */
export const COMPARED = [
    'hisMessages', 'turns', 'proactiveShare', 'avgChars', 'medianChars', 'avgLines', 'medianLines',
    'assistantToneRate', 'repeatRate', 'duplicateRate', 'nearDuplicateRate', 'openingRepeatRate',
    'nagRate', 'nagRepeatRate', 'questionEndRate', 'promiseRate', 'scriptRate', 'correctedRate',
    'latency.p50', 'latency.p90',
] as const;
export type ComparedKey = (typeof COMPARED)[number];

export interface Delta { before: number | null; after: number | null; delta: number | null }

const pick = (metrics: Metrics, key: ComparedKey): number | null => {
    if (key === 'latency.p50') return metrics.latency?.p50 ?? null;
    if (key === 'latency.p90') return metrics.latency?.p90 ?? null;
    const value = (metrics as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** 这一次比上一次：每个数的前、后、差（任一边没有就是 null） */
export function compareMetrics(before: Metrics, after: Metrics): Record<ComparedKey, Delta> {
    const out = {} as Record<ComparedKey, Delta>;
    for (const key of COMPARED) {
        const a = pick(before, key);
        const b = pick(after, key);
        out[key] = { before: a, after: b, delta: a === null || b === null ? null : round(b - a, 4) };
    }
    return out;
}

/** 每个数的中文名和怎么显示 */
const LABELS: Record<ComparedKey, { name: string; kind: 'count' | 'rate' | 'chars' | 'seconds' }> = {
    hisMessages: { name: '他发来', kind: 'count' },
    turns: { name: '她的轮数', kind: 'count' },
    proactiveShare: { name: '主动占比', kind: 'rate' },
    avgChars: { name: '平均字数', kind: 'chars' },
    medianChars: { name: '字数中位', kind: 'chars' },
    avgLines: { name: '平均行数', kind: 'chars' },
    medianLines: { name: '行数中位', kind: 'chars' },
    assistantToneRate: { name: '助手腔', kind: 'rate' },
    repeatRate: { name: '重复（出口检查口径）', kind: 'rate' },
    duplicateRate: { name: '整句重复', kind: 'rate' },
    nearDuplicateRate: { name: '近似重复', kind: 'rate' },
    openingRepeatRate: { name: '开头重复', kind: 'rate' },
    nagRate: { name: '叮嘱', kind: 'rate' },
    nagRepeatRate: { name: '一段里又叮嘱', kind: 'rate' },
    questionEndRate: { name: '问句结尾', kind: 'rate' },
    promiseRate: { name: '做不到的事', kind: 'rate' },
    scriptRate: { name: '编对话', kind: 'rate' },
    correctedRate: { name: '他当场纠正', kind: 'rate' },
    'latency.p50': { name: '回复延迟中位', kind: 'seconds' },
    'latency.p90': { name: '回复延迟 p90', kind: 'seconds' },
};

const pct = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null) => (value === null ? '—' : String(value));
const secs = (value: number | null) => {
    if (value === null) return '—';
    if (value < 120) return `${value}秒`;
    if (value < 7200) return `${round(value / 60, 1)}分`;
    return `${round(value / 3600, 1)}时`;
};
const show = (kind: (typeof LABELS)[ComparedKey]['kind'], value: number | null) => (kind === 'rate' ? pct(value) : kind === 'seconds' ? secs(value) : num(value));
const signed = (kind: (typeof LABELS)[ComparedKey]['kind'], delta: number | null) => {
    if (delta === null) return '—';
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    const abs = Math.abs(delta);
    return kind === 'rate' ? `${sign}${(abs * 100).toFixed(1)} 个点` : kind === 'seconds' ? `${sign}${secs(abs)}` : `${sign}${round(abs, 1)}`;
};

/** 给人看的中文表（只有数） */
export function formatMetrics(metrics: WeeklyMetrics, compare?: { previous: MetricsRun; deltas: Record<ComparedKey, Delta> } | null): string {
    const out: string[] = [];
    const span = `${dayKey(Date.parse(metrics.from))} 至 ${dayKey(Date.parse(metrics.to) - 1)}`;
    out.push(`# 每周效果数（${span}，${metrics.days.length} 天，范围 ${metrics.scope}，联系人 ${metrics.contacts} 个）`, '');
    out.push('只有数，没有原话。比例的分母是「她有文字的轮数」；线上发之前出口检查已拦过一遍，这里是漏过去的，看走向。', '');
    out.push('## 每天', '');
    const header = ['日期', '他发', '她轮数', '回/主动/接着', '平均字', '中位字', '平均行', '助手腔', '重复', '叮嘱', '问句结尾', '做不到', '编对话', '被纠正', '延迟中位'];
    out.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
    const row = (label: string, m: Metrics) => `| ${[
        label, m.hisMessages, m.turns, `${m.replyTurns}/${m.proactiveTurns}/${m.followOnTurns}`, num(m.avgChars), num(m.medianChars), num(m.avgLines),
        pct(m.assistantToneRate), pct(m.repeatRate), pct(m.nagRate), pct(m.questionEndRate), pct(m.promiseRate), pct(m.scriptRate), pct(m.correctedRate), secs(m.latency.p50),
    ].join(' | ')} |`;
    for (const day of metrics.days) out.push(row(day.day.slice(5), day));
    out.push(row('**整周**', metrics.week));
    const w = metrics.week;
    out.push('', '## 整周', '');
    out.push(`- 他发来 ${w.hisMessages} 条；她 ${w.herBubbles} 条、${w.turns} 轮（回他 ${w.replyTurns}、自己找他 ${w.proactiveTurns}、接着自己说 ${w.followOnTurns}），主动占比 ${pct(w.proactiveShare)}`);
    out.push(`- 有文字的轮 ${w.textTurns}：每轮平均 ${num(w.avgChars)} 字（中位 ${num(w.medianChars)}），平均 ${num(w.avgLines)} 行（中位 ${num(w.medianLines)}）`);
    out.push(`- 助手腔 ${pct(w.assistantToneRate)}；问句结尾 ${pct(w.questionEndRate)}`);
    out.push(`- 重复：出口检查口径 ${pct(w.repeatRate)}；整句重复 ${pct(w.duplicateRate)}、近似重复 ${pct(w.nearDuplicateRate)}、开头重复 ${pct(w.openingRepeatRate)}`);
    out.push(`- 叮嘱 ${pct(w.nagRate)}；同一段里又叮嘱同一类 ${pct(w.nagRepeatRate)}`);
    out.push(`- 编造嫌疑：做不到的事 ${pct(w.promiseRate)}、编对话 ${pct(w.scriptRate)}、他下一条在纠正她 ${pct(w.correctedRate)}`);
    const l = w.latency;
    out.push(`- 回他的延迟（他最后一条 → 她第一条，${l.count} 轮）：中位 ${secs(l.p50)}、p90 ${secs(l.p90)}；≤30 秒 ${l.within30s}、30 秒–2 分 ${l.within2m}、2–10 分 ${l.within10m}、10–60 分 ${l.within1h}、1 小时以上 ${l.over1h}`);
    if (compare !== undefined) {
        out.push('', '## 和上一次比', '');
        if (!compare) out.push('- 日志里没有同一范围的上一次，这次记下来，下周再比。');
        else {
            const prev = compare.previous;
            out.push(`上一次：${prev.at.slice(0, 10)} 跑的，窗口 ${dayKey(Date.parse(prev.from))} 至 ${dayKey(Date.parse(prev.to) - 1)}（${prev.days?.length ?? '?'} 天）`, '');
            out.push('| 数 | 上次 | 这次 | 变化 |', '|---|---|---|---|');
            for (const key of COMPARED) {
                const { name, kind } = LABELS[key];
                const d = compare.deltas[key];
                out.push(`| ${name} | ${show(kind, d.before)} | ${show(kind, d.after)} | ${signed(kind, d.delta)} |`);
            }
        }
    }
    return `${out.join('\n')}\n`;
}
