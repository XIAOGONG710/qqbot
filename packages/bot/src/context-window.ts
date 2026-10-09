// 原始聊天的另一种放法（ADR 0043）：最近 N 轮原文，更早的整理成几条要点。默认关（配置 contextTurns = 0），线上还是 fading.ts 的最近 80 条（ADR 0036 决策 3）；
// 实验是看「最近若干轮 + 要点」能不能少一点自我模仿、又不忘事。
// - 一轮 = 他的一条或连着几条，加上她接着的回复；
// - 切口每 step 轮才往后挪一次：原文在 N 到 N + step - 1 轮之间，要点不用每轮重写；
// - 要点只写事实（安排、发生的事、东西和人、约好的事），不写语气、不照抄原话——照抄了等于把旧回复又放回去；
// - 7 天以前的照旧不放（fading.ts recentChat），靠长期记忆。

import { MIDNIGHT_RULE } from './follow-ups.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { Log } from './log.ts';
import type { ChatMessage, OpenAIMessage } from './prompt.ts';
import { estimateTokens } from './tokens.ts';

export interface TurnWindow {
    /** 原文至少留几轮 */
    turns: number;
    /** 切口每几轮挪一次 */
    step: number;
}

/** 要点那一段的开头（模拟器报告按它找） */
export const SUMMARY_HEADER = '[你们前面聊过的事';
/** 拿去整理的较早聊天最多几条（再早的靠长期记忆） */
const SUMMARY_INPUT = 200;
const WEEKDAYS = '日一二三四五六';

/** 每一轮第一条的下标：他接着她说的第一条；开头是她说的也算一轮 */
export function turnStarts(chat: readonly Pick<ChatMessage, 'role'>[]): number[] {
    const starts: number[] = [];
    chat.forEach((message, i) => {
        if (i === 0 || (message.role === 'user' && chat[i - 1]!.role === 'assistant')) starts.push(i);
    });
    return starts;
}

/** 原文从哪一条开始放（0 = 全放）：至少留 turns 轮，切口按 step 轮一挪 */
export function turnCut(chat: readonly Pick<ChatMessage, 'role'>[], window: TurnWindow): number {
    const starts = turnStarts(chat);
    const extra = starts.length - window.turns;
    if (extra < window.step) return 0;
    return starts[Math.floor(extra / window.step) * window.step]!;
}

const pad = (n: number) => String(n).padStart(2, '0');
function stamp(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return `[${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}] `;
}

/** 整理要点的请求 */
export function summaryRequest(older: readonly ChatMessage[], names: { user: string; char: string }): OpenAIMessage[] {
    const lines = older.slice(-SUMMARY_INPUT).map(m => `${stamp(m.time)}${m.role === 'user' ? names.user : names.char}：${m.content}`);
    return [
        {
            role: 'system',
            content: `你在帮${names.char}记事。下面是${names.char}和${names.user}较早的聊天记录（按时间，带日期和星期）。` +
                `把以后聊天可能用得上的事实整理成要点：${names.user}和${names.char}各自说过的安排、发生的事、提到的东西和人、约好或答应的事。` +
                '每条写清楚是哪天说的；说的是将来某天的，写成具体的日期和星期。' + MIDNIGHT_RULE +
                // 10-09 探针（凌晨的「明天」、改口、谁的事，各 3 次）：凌晨说的明天 2 次记错一天；取消了的计划 3 次都还单独留着一条「要去」；1 次把她说他的话记成她自己
                '同一件事后来改了、取消了或没做成的，合成一条只写最后的结果（「原定10月10日周六爬千佛山，10月8日说下雨不去了」），不要另留一条原来的打算。' +
                `每条写清楚是谁的事：${names.user}的室友、家人这些人的事写那个人；顺着对方的话说的（「那正好在宿舍躺着」）说的是对方，不是自己。` +
                '只写事实，不写语气、口头禅和说话方式，不照抄原话，寒暄、玩笑、互损不写。每条一行，用「- 」开头，最多 12 条；没有值得记的就只写「- 无」。',
        },
        { role: 'user', content: lines.join('\n') },
    ];
}

/** 这段较早聊天的要点：整理好了（text 可以是 undefined：没有值得记的），或者还在整理 / 整理失败（调用方这一轮照旧放原文，不等它） */
export type SummaryState = { ready: true; text: string | undefined } | { ready: false };

export interface Summarizer {
    /** 立即返回、不等模型：同一段已经整理好就给要点；没整理好就在后台开始整理（同一时间只整理一段），这一轮返回 ready: false */
    (older: readonly ChatMessage[]): SummaryState;
    /** 后台的整理做完（模拟器每轮等它，结果可复现；线上不等） */
    idle(): Promise<void>;
}

/** 整理一次最多等这么久，超时算失败（ADR 0043 上线门槛：摘要不能拖住回复，也不能一直挂着） */
export const SUMMARY_TIMEOUT_MS = 60_000;
/** 整理失败以后，同一段隔这么久再试 */
export const SUMMARY_RETRY_MS = 5 * 60_000;

const summaryKey = (older: readonly ChatMessage[]) => `${older.length}|${older.at(-1)?.time ?? ''}|${older.at(-1)?.content ?? ''}`;

/**
 * 整理要点（ADR 0043）：同一段较早的聊天只整理一次（切口不动时每轮都是同一段）。
 * 不在回复路径上等模型：切口刚挪的那一轮返回 ready: false，调用方照旧放最近 80 条；后台整理好了，下一轮起用要点。
 * file：整理好的那一段存盘，重启以后不用再整理一遍（ADR 0039：重启前后提示词一样）。
 */
export function contextSummarizer(options: {
    names: { user: string; char: string };
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    log: Log;
    file?: string;
    now?: () => number;
    timeoutMs?: number;
}): Summarizer {
    const now = options.now ?? Date.now;
    const saved = options.file ? readJsonOr<{ key?: unknown; text?: unknown } | undefined>(options.file, undefined, options.log) : undefined;
    let cached: { key: string; text: string | undefined } | undefined = typeof saved?.key === 'string'
        ? { key: saved.key, text: typeof saved.text === 'string' ? saved.text : undefined }
        : undefined;
    let running: { key: string; done: Promise<void> } | undefined;
    const failedAt = new Map<string, number>();

    function start(key: string, older: readonly ChatMessage[]): void {
        const request = summaryRequest(older, options.names);
        const tokens = request.reduce((n, m) => n + estimateTokens(m.content), 0);
        const began = now();
        const timeoutMs = options.timeoutMs ?? SUMMARY_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs); });
        const done = Promise.race([options.generate(request), timeout]).then(output => {
            const points = output.split('\n').map(line => line.trim()).filter(line => /^[-•]\s*\S/.test(line) && !/^[-•]\s*无$/.test(line));
            const text = points.length ? `${SUMMARY_HEADER}（更早的聊天原文没放进来，这是要点，只作参考；和下面从记忆里想起来的对不上时，以这里为准）：\n${points.join('\n')}]` : undefined;
            cached = { key, text };
            if (options.file) writeJsonAtomic(options.file, text === undefined ? { key } : { key, text });
            failedAt.delete(key);
            options.log(`上下文要点：较早的 ${older.length} 条整理成 ${points.length} 条（请求约 ${tokens} token，用了 ${((now() - began) / 1000).toFixed(1)} 秒）`);
        }, error => {
            // 整理失败：这一段过一会儿再试；在那之前照旧放原文
            failedAt.set(key, now());
            options.log(`上下文要点整理失败（${SUMMARY_RETRY_MS / 60_000} 分钟后再试，这期间照旧放最近 80 条）：${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
            clearTimeout(timer);
            if (running?.key === key) running = undefined;
        });
        running = { key, done };
    }

    const summarize = ((older: readonly ChatMessage[]): SummaryState => {
        const key = summaryKey(older);
        if (cached?.key === key) return { ready: true, text: cached.text };
        const failed = failedAt.get(key);
        if (!running && (failed === undefined || now() - failed >= SUMMARY_RETRY_MS)) {
            start(key, older);
            options.log('上下文要点：切口挪了，后台在整理，这一轮照旧放最近 80 条');
        }
        return { ready: false };
    }) as Summarizer;
    summarize.idle = async () => {
        while (running) await running.done;
    };
    return summarize;
}
