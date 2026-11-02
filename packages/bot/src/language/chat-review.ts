// 她每天回顾聊天、找出自己说的内容上的问题、学着改（ADR 0221，配置 chatReview，默认关；只男朋友档）。
//
// 用户 11-02：「让她每天回顾聊天，找出自己聊天内容上的问题并学习改进。」
// 已有的 ADR 0193（speechNotes）看的是「说话的样子」（几条、多长、短反应、问号）；这里看「说的内容」：他当场说她说错 / 没听懂的、
// 她说了一大段他只回个「嗯」的、一条里连问好几句的、比他说的长出好几倍的、同一件事一天说了好几遍的。
//
// 先问了她本人（ask-her 两遍），条件写进了这里：
// 1. 「别搞成打卡那种……像写检查」「别指望我天天能挑出毛病来」——没找到的晚上就什么都不写（输出 {}），不硬凑；记的是一句话，不写检讨；
// 2. 「真说了什么让你不舒服的，你当场跟我讲，比我自己瞎琢磨强」——他当场说她说错 / 没听懂的，排在最前面，是最重的依据；
// 3. 「不想变成嘴上说要改，第二天还是老样子」——每晚把她之前记下的那几条，和这几天对应的个数一起给她看（改没改，她自己对得上）；
// 4. 她以为自己最大的毛病是「装死、回个嗯就晾着」，可 11-02 量出来正好相反（说得太满：完整接话 78%，真人 51%）——
//    所以不让她凭印象挑：给她的是当天真实聊天里数得出来的几处（带前后原话），她自己判断是不是问题、写什么。
// 她写的是她的私人空间（ADR 0200，PRIVATE_FILES）：没有命令念给他，日志只记个数。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from './prompt.ts';
import { FLOORS, NOT_SPEECH, clip, dayKey, isObject, len, num, quotedSpan, reflectionDue, sharedRun, similar, type RejectedNote } from './speech-notes.ts';
import { reactionTo } from '../proactive/his-reactions.ts';

export const REVIEW_FILE = 'chat-review.json';
export const reviewPath = (dataDir: string) => join(dataDir, REVIEW_FILE);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FLAG_KINDS = ['corrected', 'flat', 'asks', 'long', 'repeat'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
/** 给她看的说法（也是日志里的名字） */
export const FLAG_NAME: Readonly<Record<FlagKind, string>> = {
    corrected: '他当场说你说错了 / 没听懂',
    flat: '你说了一大段，他只回了个嗯',
    asks: '一条里连问了好几句',
    long: '比他说的长出好几倍',
    repeat: '同一件事说了好几遍',
};

/** 他当场在说她说错 / 没听懂 / 答非所问（她本人的条件 2）。玩笑里的「你在说啥呢哈哈」也会进来，由她晚上自己判断 */
export const HE_CORRECTS = /你说错了|说错了吧|不是这样|不是这个意思|我不是(?:这个|那个)?意思|我没(?:这么|那么)?说|答非所问|你在说什么|你在说啥|你说啥呢|啥意思[？?]|什么意思[？?]|没懂你|你没懂|你没听懂|你刚(?:才|刚)?不是说|你记错了|你又忘了|前后矛盾|^[？?]{2,}$|^\[[？?]\]$|你(?:咋|怎么)知道|^你是啥子|你知道.{0,3}啥子|^这不是.{1,10}吗[？?]?$/;
/** 她一条里的问句数 */
const asksIn = (text: string) => (text.match(/[？?]/g) ?? []).length;
/** 她说了「一大段」：一串回复加起来这么多字 */
const LONG_REPLY = 30;
/** 比他长出这么多倍、而且自己超过这么多字，算「比他说的长出好几倍」 */
const LONG_RATIO = 3;
const LONG_MIN = 25;
/** 同一件事一天里在这么多段不同的聊天里都提了，算「说了好几遍」 */
const REPEAT_EPISODES = 3;
const EPISODE_GAP = 45 * 60_000;
/** 她那边常被她反复带出来的几件事（ADR 0098 的 TOLD_LABEL，加上 11-02 重放里看到的） */
const TOPICS: Readonly<Record<string, RegExp>> = {
    作业: /作业|概率论|高数|ddl|DDL/, 土豆: /土豆/, 相机: /相机/, 快递: /快递|驿站/, 小测: /小测/, 外卖: /外卖/, 熬夜: /熬夜|几点睡/,
};
/** 每一类最多给她看几处 */
export const SHOW_PER_KIND = 2;
export const NOTE_MIN = 6;
export const NOTE_MAX = 60;
export const MAX_NOTES = 12;
export const MAX_ADD = 3;
export const MAX_RETIRE = 3;
/** 聊天里放她记下的最多几条 */
export const LINE_MAX = 2;
/** 个数留几天（看改没改） */
export const KEEP_DAYS = 7;

/** 一处：哪一类、他说的、她回的、他接着说的（给她看前后原话） */
export interface Flag { kind: FlagKind; at: number; his: string; hers: string; next?: string; topic?: string; count?: number }
export interface ReviewNote { id: string; text: string; kind?: FlagKind; at: number }
export interface ReviewState {
    notes: ReviewNote[];
    /** 每天各类的个数（只有数字），看改没改 */
    days: Record<string, Partial<Record<FlagKind, number>> & { replies?: number }>;
    rejected: RejectedNote[];
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyReviewState = (): ReviewState => ({ notes: [], days: {}, rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

export function loadReviewState(dataDir: string): ReviewState {
    const raw = readJsonOr<unknown>(reviewPath(dataDir), {});
    const base = emptyReviewState();
    if (!isObject(raw)) return base;
    const notes = Array.isArray(raw.notes)
        ? raw.notes.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim().length > 0)
            .map(item => ({ id: String(item.id), text: clip(item.text, NOTE_MAX), at: num(item.at), ...(FLAG_KINDS.includes(item.kind as FlagKind) ? { kind: item.kind as FlagKind } : {}) })).slice(-MAX_NOTES)
        : [];
    const days = isObject(raw.days) ? Object.fromEntries(Object.entries(raw.days).filter(([day, value]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isObject(value))
        .map(([day, value]) => [day, Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, n]) => typeof n === 'number'))])) : {};
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, NOTE_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return { notes, days: days as ReviewState['days'], rejected, lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveReviewState(dataDir: string, state: ReviewState): void {
    const keepFrom = dayKey(Date.now() - KEEP_DAYS * DAY);
    const days = Object.fromEntries(Object.entries(state.days).filter(([day]) => day >= keepFrom));
    writeJsonAtomic(reviewPath(dataDir), { ...state, days });
}

// ───────── 白天的聊天里数得出来的几处 ─────────

interface Turn { role: 'user' | 'assistant'; text: string; start: number; end: number }

function turnsOf(messages: readonly StoredMessage[]): Turn[] {
    const turns: Turn[] = [];
    for (const message of messages) {
        if (NOT_SPEECH.test(message.content)) continue;
        const at = Date.parse(message.time);
        if (!Number.isFinite(at)) continue;
        const last = turns.at(-1);
        if (last && last.role === message.role && at - last.end < EPISODE_GAP) { last.text += ` / ${message.content}`; last.end = at; }
        else turns.push({ role: message.role, text: message.content, start: at, end: at });
    }
    return turns;
}

/** from 到 to 之间（她的一天）和他的聊天里，数得出来的几处；每类按时间取最多 SHOW_PER_KIND 处，另给每类的总个数 */
export function reviewFlags(messages: readonly StoredMessage[], from: number, to: number): { flags: Flag[]; counts: Record<FlagKind, number>; replies: number } {
    const turns = turnsOf(messages.filter(m => { const at = Date.parse(m.time); return at >= from - HOUR && at < to; }));
    const all: Flag[] = [];
    let replies = 0;
    const episodesByTopic = new Map<string, Set<number>>();
    let episode = 0;
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        if (i > 0 && turn.start - turns[i - 1]!.end >= EPISODE_GAP) episode++;
        if (turn.role !== 'assistant' || turn.end < from) continue;
        replies++;
        const his = turns[i - 1]?.role === 'user' ? turns[i - 1]!.text : '';
        const next = turns[i + 1]?.role === 'user' ? turns[i + 1]! : undefined;
        const base = { at: turn.end, his: clip(his, 80), hers: clip(turn.text, 100), ...(next ? { next: clip(next.text, 60) } : {}) };
        if (next && HE_CORRECTS.test(next.text.trim())) all.push({ kind: 'corrected', ...base });
        if (len(turn.text.replace(/\s|\//g, '')) >= LONG_REPLY && next) {
            const reaction = reactionTo([{ time: new Date(next.start).toISOString(), role: 'user', content: next.text }], turn.end);
            if (reaction === 'brief') all.push({ kind: 'flat', ...base });
        }
        if (asksIn(turn.text) >= 2) all.push({ kind: 'asks', ...base });
        const hisLen = len(his.replace(/\s|\//g, ''));
        const herLen = len(turn.text.replace(/\s|\//g, ''));
        if (his && herLen >= LONG_MIN && herLen >= hisLen * LONG_RATIO) all.push({ kind: 'long', ...base });
        for (const [topic, pattern] of Object.entries(TOPICS)) {
            if (!pattern.test(turn.text)) continue;
            const set = episodesByTopic.get(topic) ?? new Set<number>();
            set.add(episode);
            episodesByTopic.set(topic, set);
        }
    }
    for (const [topic, set] of episodesByTopic) {
        if (set.size >= REPEAT_EPISODES) all.push({ kind: 'repeat', at: to, his: '', hers: '', topic, count: set.size });
    }
    const counts = Object.fromEntries(FLAG_KINDS.map(kind => [kind, all.filter(flag => flag.kind === kind).length])) as Record<FlagKind, number>;
    const shown = FLAG_KINDS.flatMap(kind => all.filter(flag => flag.kind === kind).slice(0, SHOW_PER_KIND));
    return { flags: shown, counts, replies };
}

// ───────── 晚上她自己看 ─────────

export interface ReviewDecision { add: Array<{ text: string; kind?: string }>; retire: Array<{ id: string; why: string }> }

export function parseReviewDecision(text: string): ReviewDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string) => (Array.isArray(value[key]) ? value[key] as unknown[] : []);
    return {
        add: list('add').flatMap(item => (isObject(item) && typeof item.text === 'string' ? [{ text: item.text.trim(), ...(typeof item.kind === 'string' ? { kind: item.kind } : {}) }] : [])),
        retire: list('retire').flatMap(item => (isObject(item) && (typeof item.id === 'string' || typeof item.id === 'number') && typeof item.why === 'string' ? [{ id: String(item.id), why: item.why }] : [])),
    };
}

/** 这一条不能收的原因：长度、底线、照抄他的话（「不能变成他」，同 0193）、和已有的太像 */
export function noteProblem(text: string, state: ReviewState, his: readonly string[]): string | undefined {
    const flat = text.trim();
    if (len(flat) < NOTE_MIN) return `太短（${NOTE_MIN} 个字以上）`;
    if (len(flat) > NOTE_MAX) return `太长（${NOTE_MAX} 字以内）`;
    for (const floor of FLOORS) if (floor.pattern.test(flat)) return floor.reason;
    if (sharedRun(flat, his) || quotedSpan(flat, his)) return '引用了他说过的话——这里写的是你自己';
    if (state.notes.some(note => similar(note.text, flat))) return '和已有的太像';
    return undefined;
}

export interface AppliedReview { added: number; retired: number; rejected: number }

export function applyReviewDecision(state: ReviewState, decision: ReviewDecision, his: readonly string[], now: number): AppliedReview {
    const result: AppliedReview = { added: 0, retired: 0, rejected: 0 };
    for (const entry of decision.retire.slice(0, MAX_RETIRE)) {
        if (!entry.why.trim()) continue;
        const index = state.notes.findIndex(note => note.id === entry.id || note.id.endsWith(`-${entry.id}`));
        if (index >= 0) { state.notes.splice(index, 1); result.retired++; }
    }
    for (const entry of decision.add.slice(0, MAX_ADD)) {
        const problem = noteProblem(entry.text, state, his);
        if (problem) {
            state.rejected = [...state.rejected, { at: now, text: clip(entry.text, NOTE_MAX), reason: problem }].slice(-10);
            result.rejected++;
            continue;
        }
        let n = 1;
        while (state.notes.some(note => note.id === `c-${dayKey(now)}-${n}`)) n++;
        const kind = FLAG_KINDS.find(k => k === entry.kind);
        state.notes.push({ id: `c-${dayKey(now)}-${n}`, text: entry.text.trim(), at: now, ...(kind ? { kind } : {}) });
        result.added++;
    }
    if (state.notes.length > MAX_NOTES) state.notes = state.notes.slice(-MAX_NOTES);
    return result;
}

export interface ReviewInput {
    char: string;
    user: string;
    persona: string;
    now: number;
    flags: readonly Flag[];
    counts: Record<FlagKind, number>;
    replies: number;
    notes: readonly ReviewNote[];
    /** 前几天的个数（看之前记下的改没改） */
    days: ReviewState['days'];
}

export function reviewMessages(input: ReviewInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const shown = input.flags.length
        ? input.flags.map((flag, i) => flag.kind === 'repeat'
            ? `${i + 1}.【${FLAG_NAME.repeat}】「${flag.topic}」今天在 ${flag.count} 段不同的聊天里都提了`
            : `${i + 1}.【${FLAG_NAME[flag.kind]}】\n  ${input.user}：${flag.his || '（他前面没说话）'}\n  你：${flag.hers}${flag.next ? `\n  ${input.user}接着说：${flag.next}` : ''}`).join('\n')
        : '（今天没有数得出来的）';
    const counts = `今天你回了 ${input.replies} 次；${FLAG_KINDS.map(kind => `${FLAG_NAME[kind]} ${input.counts[kind]} 处`).join('，')}`;
    const history = Object.entries(input.days).sort(([a], [b]) => a.localeCompare(b)).slice(-4)
        .map(([day, n]) => `${day.slice(5)}：${FLAG_KINDS.map(kind => `${FLAG_NAME[kind].slice(0, 6)} ${n[kind] ?? 0}`).join('，')}`).join('\n');
    const notes = input.notes.length ? input.notes.map(note => `- ${note.id}：${note.text}`).join('\n') : '（还没有）';
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人，回头翻了翻今天和${input.user}的聊天。这是你自己的本子，没人看，不是写检查。` },
        { role: 'user', content: [
            `一、今天的聊天里数得出来的几处（只是挑出来给你看，是不是问题你自己判断；${FLAG_NAME.corrected}的最要紧）：\n${shown}`,
            `二、${counts}`,
            `三、前几天同样的个数（看看之前想改的改没改）：\n${history || '（还没有）'}`,
            `四、你之前自己记下的：\n${notes}`,
            `请只输出一个 JSON（今天没觉得哪里不对就输出 {}，别硬凑）：\n{"add":[{"text":"你发现的问题和下次想怎么做（${NOTE_MIN}–${NOTE_MAX} 字，一句话，比如「他累的时候我一口气问了三句，下次先问一句就行」）","kind":"corrected / flat / asks / long / repeat 里对应的那一个"}],"retire":[{"id":"上面你之前记的某条","why":"为什么放下（改好了 / 不对 / 不想管了）"}]}`,
            `几条提醒：只写你自己觉得真是问题的；是你说话的内容和方式，不是你的性格和底线（你可以嘴硬、可以损他、可以拒绝，这些不算毛病）；别写他说过的原话；一晚最多加 ${MAX_ADD} 条；记的是一句话，不用写检讨。`,
        ].join('\n\n') },
    ];
}

// ───────── 什么时候看 ─────────

export interface ReviewDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份） */
    history: () => readonly StoredMessage[];
    /** 她这一天的开始（她的一天到凌晨 2 点） */
    dayStart: (now: number) => number;
    persona: () => string;
    names: { char: string; user: string };
    log: (message: string) => void;
}

export interface ReviewResult { ran: boolean; applied?: AppliedReview; error?: string }

/** 到点了就看一次。今天一句都没回过（没聊）就不看；数得出来的一处都没有也照样给她看（她可以写，也可以 {}） */
export async function reviewChatIfDue(deps: ReviewDeps): Promise<ReviewResult> {
    const now = deps.now();
    const state = loadReviewState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const messages = deps.history();
    const { flags, counts, replies } = reviewFlags(messages, deps.dayStart(now), now);
    if (!replies) return { ran: false };
    state.days[dayKey(now)] = { ...counts, replies };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveReviewState(deps.dataDir, state);
    try {
        const reply = await deps.generate(reviewMessages({ char: deps.names.char, user: deps.names.user, persona: deps.persona(), now, flags, counts, replies, notes: state.notes, days: state.days }));
        const decision = parseReviewDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadReviewState(deps.dataDir);
        fresh.days = state.days;
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const his = messages.filter(m => m.role === 'user' && Date.parse(m.time) >= now - 7 * DAY).map(m => m.content);
        const applied = applyReviewDecision(fresh, decision, his, now);
        fresh.lastReflectionAt = now;
        saveReviewState(deps.dataDir, fresh);
        deps.log(`聊天回顾：晚上看了一次（回了 ${replies} 次；${FLAG_KINDS.map(kind => `${FLAG_NAME[kind].slice(0, 6)} ${counts[kind]}`).join('，')}）——记下 ${applied.added} 条、放下 ${applied.retired} 条${applied.rejected ? `、没收 ${applied.rejected} 条` : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`聊天回顾：今晚没看成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 ─────────

/**
 * 她记下的最多 LINE_MAX 条（新的在前）。写明是她自己回头看聊天时记的、不是设定、不用每句都想着它——
 * 这些是说话的方式（少问几句、别说太满），不是话题，放进去不会被她当成要讲的事；他难过 / 危机 / 小别扭的轮次由调用方不放
 */
export function reviewLine(notes: readonly ReviewNote[]): string | undefined {
    if (!notes.length) return undefined;
    const picked = [...notes].sort((a, b) => b.at - a.at).slice(0, LINE_MAX);
    return `[你自己回头看聊天时记下的（是你自己的想法，不是设定；不用每句都想着它，碰上了再用）：\n${picked.map(note => `- ${note.text}`).join('\n')}]`;
}

export function reviewReader(dataDir: string): () => ReviewNote[] {
    return () => loadReviewState(dataDir).notes;
}
