// 每日「像不像」原始数报告（任务书 T2）：读线上数据目录的副本（聊天、主动记录、事件账、反馈记录）和 Koishi 日志，
// 对某一天输出一页 markdown。只读、不调模型；**只给原始数，不打分、没有「像真人指数」**——判断留给人。
// 为什么：终极目标的几条验收现在没有一条每天在量；这页让「她那天过得怎么样、说得怎么样、出了什么事」每天有一眼能看完的数。
// 用法：npm run daily-report -w packages/bot -- <YYYY-MM-DD> [--data <数据目录>] [--logs <Koishi 日志目录>]
// 报告里不放任何聊天原话；联系人只显示 QQ 号后四位。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 事件类 → 她提到这件事时会出现的词。放在文件顶部，容易改；匹配的是她当天说的文字 */
export const EVENT_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
    sleep: ['睡', '困', '起床', '被窝'],
    eat: ['吃', '饭', '食堂', '外卖', '饿'],
    attend_class: ['课', '上课', '老师', '教室'],
    study: ['作业', '报告', '截止', '复习', '题', '代码', '实验'],
    read_book: ['书', '小说', '章', '卷', '看到'],
    leisure: ['刷', '视频', '剧', '番', '游戏', '歌'],
    work_on_project: ['拍', '修图', '调色', '相机', '片子', '作品', '摄影'],
    feed_cat: ['猫', '土豆', '猫粮'],
    receive_money: ['转账', '钱', '红包'],
    interact_npc: ['闺蜜', '室友', '同学', '雨桐'],
    meet: ['见面', '约', '一起'],
    rest: ['歇', '躺', '休息'],
};

export interface ChatRow { time: string; role: 'user' | 'assistant'; content: string; messageId?: number }
export interface ProactiveEntry { id: string; at: string; result: string; messageIds?: number[] }
export interface LedgerEvent { kind: string; day: string }
export interface FeedbackEntry { at: string; label: string }
export interface LogEntry { timestamp: number; content: string }

export interface ReportData {
    /** 联系人 QQ → 聊天记录 */
    chats: Map<number, ChatRow[]>;
    proactive: Map<number, ProactiveEntry[]>;
    events: LedgerEvent[];
    feedback: FeedbackEntry[];
    logs: LogEntry[];
}

const DAY_MS = 86_400_000;
const TURN_GAP_MS = 20_000;
const cp = (text: string) => [...text].length;
const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    return n ? (n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2) : 0;
};
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');

/** 一条聊天内容是什么：[图片…] 图，[语音…] 语音，只有 [xxx] 的是表情（QQ 小黄脸 / 动画表情 / 图片表情），其余是文字 */
export function contentKind(content: string): 'image' | 'voice' | 'face' | 'text' {
    const text = content.trim();
    if (/^\[图片/.test(text)) return 'image';
    if (/^\[语音/.test(text)) return 'voice';
    if (/^(\[[^\]\n]+\]\s*)+$/.test(text) || /<sticker:/.test(text)) return 'face';
    return 'text';
}

const isQuestion = (bubbles: string[]) => bubbles.some(bubble => /[？?]\s*$/.test(bubble.trim()) || /[吗呢]\s*$/.test(bubble.trim()));

const startOf = (date: string) => Date.parse(`${date}T00:00:00+08:00`);

interface Counts { text: number; face: number; image: number; voice: number }
const countKinds = (rows: ChatRow[]): Counts => {
    const counts: Counts = { text: 0, face: 0, image: 0, voice: 0 };
    for (const row of rows) counts[contentKind(row.content)]++;
    return counts;
};
const total = (counts: Counts) => counts.text + counts.face + counts.image + counts.voice;
const show = (counts: Counts) => `${total(counts)}（文字 ${counts.text}、表情 ${counts.face}、图片 ${counts.image}、语音 ${counts.voice}）`;

export function buildReport(data: ReportData, date: string): string {
    const from = startOf(date);
    if (!Number.isFinite(from)) throw new Error(`日期要写成 YYYY-MM-DD：${date}`);
    const to = from + DAY_MS;
    const inDay = (iso: string) => { const t = Date.parse(iso); return t >= from && t < to; };
    const out: string[] = [`# ${date} 每日原始数（只给数，不评分）`, ''];

    // 1. 量
    out.push('## 1. 量', '');
    const hers: ChatRow[] = [];
    const turns: string[][] = [];
    let hisAll = 0;
    for (const [qq, rows] of [...data.chats].sort(([a], [b]) => a - b)) {
        const today = rows.filter(row => inDay(row.time));
        const his = countKinds(today.filter(row => row.role === 'user'));
        const her = countKinds(today.filter(row => row.role === 'assistant'));
        const proactive = (data.proactive.get(qq) ?? []).filter(entry => entry.result === 'sent' && inDay(entry.at));
        out.push(`- 联系人 …${String(qq).slice(-4)}：他发来 ${show(his)}；她回复 ${show(her)}；其中她主动 ${proactive.length} 次（${proactive.reduce((sum, entry) => sum + (entry.messageIds?.length ?? 1), 0)} 条）`);
        hisAll += total(his);
        hers.push(...today.filter(row => row.role === 'assistant'));
        let turn: string[] | undefined;
        let last = 0;
        for (const row of today) {
            if (row.role !== 'assistant') { turn = undefined; continue; }
            const t = Date.parse(row.time);
            if (turn && t - last <= TURN_GAP_MS) turn.push(row.content); else { turn = [row.content]; turns.push(turn); }
            last = t;
        }
    }
    if (!data.chats.size) out.push('- 没有聊天记录文件');
    if (!hisAll) out.push('', '**这一天他一条都没发。**下面的数仍然照给（对照「她自己在过日子」这条，这种日子最有意义）。');

    // 2. 表层
    out.push('', '## 2. 表层（她的文字，按「间隔 ≤ 20 秒的连发算一轮」）', '');
    const textBubbles = hers.filter(row => contentKind(row.content) === 'text').map(row => row.content);
    const textTurns = turns.map(turn => turn.filter(bubble => contentKind(bubble) === 'text')).filter(turn => turn.length);
    if (!textBubbles.length) {
        out.push('- 她这天没有说文字。');
    } else {
        const lengths = textBubbles.map(cp);
        const one = textTurns.filter(turn => turn.length === 1).length;
        out.push(`- 轮数 ${textTurns.length}，气泡 ${textBubbles.length}`);
        out.push(`- 一轮一条 ${pct(one, textTurns.length)}，两条 ${pct(textTurns.filter(turn => turn.length === 2).length, textTurns.length)}，三条以上 ${pct(textTurns.filter(turn => turn.length >= 3).length, textTurns.length)}`);
        out.push(`- 每条中位 ${median(lengths)} 字，1–3 字的占 ${pct(lengths.filter(length => length <= 3).length, lengths.length)}`);
        out.push(`- 带问句的轮 ${pct(textTurns.filter(isQuestion).length, textTurns.length)}`);
        out.push('- 参照（DSH 的真人语料，口径不同，仅供对照）：一轮一条 51–65%、两条 22–28%、三条以上 14–23%；每条中位 6–7 字；问句 10–16%');
    }

    // 3. 断联指标
    out.push('', '## 3. 她过的事 vs 她说起的事（对应「没人找她时她也在过日子」）', '');
    const events = data.events.filter(event => event.day === date);
    const herText = textBubbles.join('\n');
    const byKind = new Map<string, number>();
    for (const event of events) byKind.set(event.kind, (byKind.get(event.kind) ?? 0) + 1);
    let mentioned = 0;
    const rows: string[] = [];
    for (const [kind, count] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
        const words = EVENT_KEYWORDS[kind] ?? [];
        const hit = words.some(word => herText.includes(word));
        if (hit) mentioned += count;
        rows.push(`  - ${kind}：账上 ${count} 件，${hit ? '她说起过' : '没说起'}${words.length ? '' : '（这一类没有关键词）'}`);
    }
    out.push(`- 事件账上她这天过的事 ${events.length} 件；其中类别在她的话里出现过关键词的 ${mentioned} 件（${events.length ? `${mentioned}/${events.length}` : '—'}）`, ...rows);
    out.push('- 关键词表在 `daily-report.ts` 顶部（`EVENT_KEYWORDS`），按类别匹配当天她说的文字；是粗匹配，只看趋势');

    // 4. 反馈
    out.push('', '## 4. 他的「假 / 像」反馈', '');
    const feedback = data.feedback.filter(entry => inDay(entry.at));
    out.push(`- 假 ${feedback.filter(entry => entry.label === 'fake').length}，像 ${feedback.filter(entry => entry.label === 'real').length}${data.feedback.length ? '' : '（没有反馈记录；通道没开或还没人用）'}`);

    // 5. 服务
    out.push('', '## 5. 服务（Koishi 日志）', '');
    const logs = data.logs.filter(entry => entry.timestamp >= from && entry.timestamp < to);
    const count = (pattern: RegExp) => logs.filter(entry => pattern.test(entry.content)).length;
    if (!logs.length) {
        out.push('- 这天没有日志（服务没跑、或日志目录不对）');
    } else {
        out.push(`- 日志 ${logs.length} 行；启动 ${count(/^名单：/)} 次`);
        out.push(`- 错误 ${count(/错误/)}、模型正文是空的 ${count(/模型正文是空的/)}、被截断 ${count(/被截断/)}、危机信号 ${count(/危机信号/)}`);
    }
    return `${out.join('\n')}\n`;
}

const readLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(line => line.trim());

/** 从数据目录和日志目录读成 ReportData；任何文件不存在都当空，坏行跳过 */
export function loadReportData(dataDir: string, logsDir?: string): ReportData {
    const data: ReportData = { chats: new Map(), proactive: new Map(), events: [], feedback: [], logs: [] };
    const qqOf = (name: string) => { const match = /^(\d+)/.exec(name); return match ? Number(match[1]) : undefined; };
    const chatDir = join(dataDir, 'chats');
    if (existsSync(chatDir)) {
        for (const name of readdirSync(chatDir).filter(file => file.endsWith('.jsonl'))) {
            const qq = qqOf(name);
            if (qq === undefined) continue;
            const rows: ChatRow[] = [];
            for (const line of readLines(join(chatDir, name))) {
                try {
                    const row = JSON.parse(line) as ChatRow;
                    if ((row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string' && Number.isFinite(Date.parse(row.time))) rows.push(row);
                } catch { /* 坏行跳过 */ }
            }
            data.chats.set(qq, rows);
        }
    }
    const proactiveDir = join(dataDir, 'proactive');
    if (existsSync(proactiveDir)) {
        for (const name of readdirSync(proactiveDir).filter(file => file.endsWith('.json'))) {
            const qq = qqOf(name);
            if (qq === undefined) continue;
            try {
                const parsed = JSON.parse(readFileSync(join(proactiveDir, name), 'utf8')) as { records?: ProactiveEntry[] };
                data.proactive.set(qq, Array.isArray(parsed.records) ? parsed.records : []);
            } catch { /* 坏文件当没有 */ }
        }
    }
    const eventsPath = join(dataDir, 'world', 'events.json');
    if (existsSync(eventsPath)) {
        try {
            const parsed = JSON.parse(readFileSync(eventsPath, 'utf8')) as { events?: LedgerEvent[] };
            if (Array.isArray(parsed.events)) data.events = parsed.events.filter(event => typeof event.kind === 'string' && typeof event.day === 'string');
        } catch { /* 当没有 */ }
    }
    const feedbackDir = join(dataDir, 'feedback');
    if (existsSync(feedbackDir)) {
        for (const name of readdirSync(feedbackDir).filter(file => /^\d{4}-\d{2}\.jsonl$/.test(file))) {
            for (const line of readLines(join(feedbackDir, name))) {
                try {
                    const entry = JSON.parse(line) as FeedbackEntry;
                    if (typeof entry.label === 'string' && Number.isFinite(Date.parse(entry.at))) data.feedback.push(entry);
                } catch { /* 坏行跳过 */ }
            }
        }
    }
    if (logsDir && existsSync(logsDir)) {
        for (const name of readdirSync(logsDir).filter(file => file.endsWith('.log'))) {
            for (const line of readLines(join(logsDir, name))) {
                try {
                    const entry = JSON.parse(line) as { timestamp?: number; content?: unknown };
                    if (typeof entry.timestamp === 'number' && typeof entry.content === 'string') data.logs.push({ timestamp: entry.timestamp, content: entry.content });
                } catch { /* 非 JSON 行跳过 */ }
            }
        }
    }
    return data;
}
