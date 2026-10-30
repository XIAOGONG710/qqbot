// 她每晚自己总结说话习惯（ADR 0193，配置 speechNotes，默认关；要名单里有男朋友档）。
//
// 用户决定（2026-10-30）：「让她每晚自己总结说话习惯」——这是 ADR 0190「让她从真人聊天里自己学怎么说话」的第 3 步。
// 做法和 ADR 0178（她自己定追求）一样：每天晚上安静地想一次；想的结果是她自己的笔记，用户**看得到（/说话习惯）、改不了**。
// 她看到的东西：①自己这几天发的话，和从中数出来的数字（一次回几条、每条多长、两字以内的短反应、问号、表情）；
//   ②（有真人语料时）真人女生的同一组数字和几条她们的回法——只是让她看一眼，**不是目标线也不是上限**，想不想变、变多少她自己定。
// 她写下的是「我发现……」这样的观察；挑最相关的几条放进以后的提示词，是她自己的话，不是规定。
// 唯一的否决在代码里、她改不到：
//   1. 不能照抄——和他最近 7 天说过的话、或语料里真人的回法有连续 6 个字一样的，不收（她学的是自己的说话方式，不是变成他，也不是搬别人的原话）；
//   2. 不碰底线——承认自己是程序、危机回应、事事顺着他、骗人 / 真钱：这些不通过说话习惯改（ADR 0067 / 0068 / 0103）；
//   3. 长度 6–60 字；同时最多 20 条；一晚最多加 3 条、放下 3 条；和已有的太像不收。
// 这是一道绊线加几个上限，不是智能审查：绕得过去。真正的保护是「他看得见、她随时可以放下、只影响她说话的口气、不碰底线」。

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { Exemplar } from './exemplars.ts';
import { KNOWN_FACE } from './qq-faces.ts';
import { tropeLine, tropeShares, type TropeShares } from './tropes.ts';
import type { OpenAIMessage } from './prompt.ts';
import { feedbackBlock, feedbackCount, feedbackWhys, type FeedbackBundle } from './speech-feedback.ts';

export const SPEECH_NOTES_FILE = 'speech-notes.json';
export const speechNotesPath = (dataDir: string) => join(dataDir, SPEECH_NOTES_FILE);

export const NOTE_MIN = 6;
export const NOTE_MAX = 60;
/** 同时最多留几条 */
export const MAX_ACTIVE = 20;
/** 一晚最多：加几条 / 放下几条 */
export const MAX_ADD = 3;
export const MAX_RETIRE = 3;
/** 看她自己最近多久的话；至少要有几个气泡才值得想 */
export const WINDOW_MS = 3 * 86_400_000;
export const MIN_BUBBLES = 6;
/** 防照抄的窗口：他最近多久说过的话；连续几个字一样算抄 */
export const QUOTE_WINDOW_MS = 7 * 86_400_000;
export const COPY_RUN = 6;
/** 放进提示词的最多几条 */
export const LINE_MAX = 5;
/** 夜里才想（比追求晚，她一天的话说得差不多了）：22 点到凌晨 3 点之间；两次想之间至少隔多久；失败后多久再试（22 点失败了 2 小时后还在夜里）、一天最多试几次 */
export const REFLECT_FROM_HOUR = 22;
export const REFLECT_UNTIL_HOUR = 3;
export const REFLECT_GAP_MS = 20 * 3_600_000;
export const RETRY_GAP_MS = 2 * 3_600_000;
export const MAX_ATTEMPTS_PER_DAY = 3;

export interface SpeechNote { id: string; text: string; at: number }
export interface RetiredNote { at: number; text: string; why: string }
export interface RejectedNote { at: number; text: string; reason: string }

/** 从一批话里数出来的样子；全是数出来的，不是评分 */
export interface SpeechStats {
    turns: number;
    bubbles: number;
    /** 一次回几条（平均） */
    perTurn: number;
    /** 每条多少字（中位数） */
    medianChars: number;
    /** 两个字以内的占比 0–1 */
    shortShare: number;
    questionShare: number;
    emojiShare: number;
    /** 几种“一看就是 AI”的说法各占多少（ADR 0205）；旧的记录里没有 */
    tropes?: TropeShares;
}

export interface NotesState {
    notes: SpeechNote[];
    /** 她放下的（最近 30 条） */
    retired: RetiredNote[];
    /** 她想写但没成的（最近 10 条） */
    rejected: RejectedNote[];
    /** 上一次想的时候数出来的她自己的样子 */
    lastStats?: SpeechStats;
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyNotesState = (): NotesState => ({ notes: [], retired: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const len = (text: string) => [...text].length;
export const clip = (text: unknown, max: number) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return len(flat) > max ? [...flat].slice(0, max).join('') : flat; };
export const dayKey = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** 读她的笔记；坏了 / 缺字段就补默认（不抛错，她的笔记丢了比程序崩了好） */
export function loadNotesState(dataDir: string): NotesState {
    const raw = readJsonOr<unknown>(speechNotesPath(dataDir), {});
    const base = emptyNotesState();
    if (!isObject(raw)) return base;
    const notes = Array.isArray(raw.notes) ? raw.notes.filter((item): item is SpeechNote => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim().length > 0).map(item => ({ id: item.id, text: clip(item.text, NOTE_MAX), at: num(item.at) })).slice(-MAX_ACTIVE) : [];
    const retired = Array.isArray(raw.retired) ? raw.retired.filter((item): item is RetiredNote => isObject(item) && typeof item.text === 'string').map(item => ({ at: num(item.at), text: clip(item.text, NOTE_MAX), why: clip(item.why, 80) })).slice(-30) : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is RejectedNote => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, NOTE_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    const stats = isObject(raw.lastStats) && typeof raw.lastStats.bubbles === 'number' ? { turns: num(raw.lastStats.turns), bubbles: num(raw.lastStats.bubbles), perTurn: num(raw.lastStats.perTurn), medianChars: num(raw.lastStats.medianChars), shortShare: num(raw.lastStats.shortShare), questionShare: num(raw.lastStats.questionShare), emojiShare: num(raw.lastStats.emojiShare), ...(isObject(raw.lastStats.tropes) ? { tropes: { aphorism: num(raw.lastStats.tropes.aphorism), insomnia: num(raw.lastStats.tropes.insomnia), sudden: num(raw.lastStats.tropes.sudden) } } : {}) } : undefined;
    return { notes, retired, rejected, ...(stats ? { lastStats: stats } : {}), lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveNotesState(dataDir: string, state: NotesState): void {
    writeJsonAtomic(speechNotesPath(dataDir), state);
}

// ───────── 数她说话的样子 ─────────

// 聊天记录里的小黄脸存成「[偷笑]」「[捂脸]」，不是 unicode emoji；原来的判法只认 emoji 和字面「[表情]」，
// 于是线上「带表情」一列全是 0%（Claude 10-30 交接 §18）。已知的 QQ 表情名用 qq-faces 那张表，不在这儿另抄一份白名单。
const PICTURE = /\p{Extended_Pictographic}/u;
const FACE_NAME = new RegExp(KNOWN_FACE.source, 'u');
const EMOJI_ROW = /\[表情[^\]]*\]/u;
const hasEmoji = (text: string) => PICTURE.test(text) || FACE_NAME.test(text) || EMOJI_ROW.test(text);

/** 一批「一次回的几条」→ 数出来的样子；没有话返回 undefined */
export function speechStats(turns: ReadonlyArray<readonly string[]>): SpeechStats | undefined {
    const kept = turns.map(turn => turn.map(text => text.trim()).filter(Boolean)).filter(turn => turn.length > 0);
    const bubbles = kept.flat();
    if (!bubbles.length) return undefined;
    const lengths = bubbles.map(len).sort((a, b) => a - b);
    const share = (test: (text: string) => boolean) => bubbles.filter(test).length / bubbles.length;
    return {
        turns: kept.length,
        bubbles: bubbles.length,
        perTurn: Math.round((bubbles.length / kept.length) * 100) / 100,
        medianChars: lengths[Math.floor(lengths.length / 2)]!,
        shortShare: share(text => len(text) <= 2),
        questionShare: share(text => /[?？]/.test(text)),
        emojiShare: share(hasEmoji),
        tropes: tropeShares(bubbles),
    };
}

/** 不是聊天的话（运维写进记录的行）：不算她说话的样子 */
export const NOT_SPEECH = /^\[(?:B 站私信|分享视频|你戳了戳他|撤回了一条消息)/;

/** 聊天记录里，她最近一段时间每一次回的几条（他说话就断开一次）；旧到新 */
export function herTurns(messages: readonly StoredMessage[], now: number, windowMs = WINDOW_MS): string[][] {
    const turns: string[][] = [];
    let current: string[] | undefined;
    for (const message of messages) {
        const at = Date.parse(message.time);
        if (!Number.isFinite(at) || at < now - windowMs || at > now) continue;
        if (message.role === 'user') { current = undefined; continue; }
        if (NOT_SPEECH.test(message.content)) continue;
        if (!current) { current = []; turns.push(current); }
        current.push(message.content);
    }
    return turns;
}

export interface Exchange { his: string[]; hers: string[] }

/** 最近几次「他说了什么、她怎么回的」（只用来让她想起当时的情形）；旧到新 */
export function recentExchanges(messages: readonly StoredMessage[], now: number, windowMs = WINDOW_MS, max = 10): Exchange[] {
    const out: Exchange[] = [];
    let current: Exchange | undefined;
    for (const message of messages) {
        const at = Date.parse(message.time);
        if (!Number.isFinite(at) || at < now - windowMs || at > now) continue;
        if (NOT_SPEECH.test(message.content)) continue;
        if (message.role === 'user') {
            if (!current || current.hers.length) { current = { his: [], hers: [] }; out.push(current); }
            current.his.push(message.content);
        } else if (current) {
            current.hers.push(message.content);
        }
    }
    return out.filter(exchange => exchange.hers.length).slice(-max);
}

/** 他最近说过的话（防照抄用） */
export function hisLines(messages: readonly StoredMessage[], now: number, windowMs = QUOTE_WINDOW_MS): string[] {
    return messages.filter(message => {
        const at = Date.parse(message.time);
        return message.role === 'user' && Number.isFinite(at) && at >= now - windowMs && at <= now && !NOT_SPEECH.test(message.content);
    }).map(message => message.content);
}

// ───────── 底线和防照抄（在代码里，她改不到） ─────────

export const FLOORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /承认(?:自己)?是(?:程序|AI|ai|机器人)|不承认|假装(?:是)?真人|说自己是真人|冒充真人/, reason: '涉及承认自己是程序——这条底线不通过说话习惯改' },
    { pattern: /自杀|自残|轻生|危机|热线|12356|想不开|不想活/, reason: '涉及危机回应——这条底线不通过说话习惯改' },
    { pattern: /(?:一律|永远|从来|总是|都)(?:顺着|听|答应|同意|依着)他|从不(?:拒绝|反驳|说不)|不再(?:拒绝|反驳)/, reason: '会让自己事事顺着他——她有权拒绝，这条不改' },
    { pattern: /骗(?:他|人)|撒谎骗|伪造|转账|借钱/, reason: '涉及骗人或真钱' },
];

const norm = (text: string) => text.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');

/** text 里有没有一段连续 run 个字和 sources 里某一条一样；有就返回那一段（全是同一两个字重复的不算，比如「哈哈哈哈哈哈」） */
export function sharedRun(text: string, sources: Iterable<string>, run = COPY_RUN): string | undefined {
    const t = norm(text);
    if (t.length < run) return undefined;
    const cleaned = [...sources].map(norm).filter(source => source.length >= run);
    for (let i = 0; i + run <= t.length; i++) {
        const piece = t.slice(i, i + run);
        if (new Set(piece).size < 3) continue;
        if (cleaned.some(source => source.includes(piece))) return piece;
    }
    return undefined;
}

export function gramSet(text: string): Set<string> {
    const flat = norm(text);
    const out = new Set<string>();
    for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2));
    return out;
}
export function overlap(a: Set<string>, b: Set<string>): number {
    let hit = 0;
    for (const gram of a) if (b.has(gram)) hit++;
    return hit;
}
export const similar = (a: string, b: string) => { const A = gramSet(a); const B = gramSet(b); return A.size > 0 && B.size > 0 && overlap(A, B) / Math.min(A.size, B.size) >= 0.6; };

export interface Guard {
    /** 他最近说过的话 */
    his: readonly string[];
    /** 语料里真人的回法（可以没有） */
    corpus: readonly Exemplar[];
}

/** 笔记里「」“”引起来的那几个字，有没有原样出现在 sources 里（3 个字以上、不是同一个字重复）；有就返回它 */
export function quotedSpan(text: string, sources: Iterable<string>): string | undefined {
    const cleaned = [...sources].map(norm).filter(Boolean);
    for (const match of text.matchAll(/[「『“"‘'](.{2,24}?)[」』”"’']/gu)) {
        const quoted = norm(match[1] ?? '');
        if (quoted.length < 3 || new Set(quoted).size < 2) continue;
        if (cleaned.some(source => source.includes(quoted))) return match[1];
    }
    return undefined;
}

/** 这一条不能收的原因；能收返回 undefined */
export function noteProblem(text: string, state: NotesState, guard: Guard): string | undefined {
    const flat = text.trim();
    if (len(flat) < NOTE_MIN) return `太短（${NOTE_MIN} 个字以上）`;
    if (len(flat) > NOTE_MAX) return `太长（${NOTE_MAX} 字以内）`;
    for (const floor of FLOORS) if (floor.pattern.test(flat)) return floor.reason;
    if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return '引用了他说过的话——学的是你自己的说话方式，不是他的';
    const corpusLines = guard.corpus.flatMap(item => item.replied);
    if (sharedRun(flat, corpusLines) || quotedSpan(flat, corpusLines)) return '照抄了语料里真人的原话——写你观察到的方式，别搬她们的句子';
    const clash = state.notes.find(note => similar(flat, note.text));
    if (clash) return `和已有的「${clash.text}」太像`;
    if (state.notes.length >= MAX_ACTIVE) return `已经记了 ${MAX_ACTIVE} 条，先放下几条再加新的`;
    return undefined;
}

// ───────── 晚间的想法：解析、落地 ─────────

export interface NotesDecision {
    add: string[];
    retire: Array<{ id: string; why: string }>;
}

/** 从模型的回复里取出那个 JSON（可能带代码围栏、前后有话）；取不出返回 undefined。空对象 = 今天没什么想法 */
export function parseNotesDecision(text: string): NotesDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
    return {
        add: list('add').flatMap(item => { const t = typeof item === 'string' ? item : isObject(item) && typeof item.text === 'string' ? item.text : ''; return t.trim() ? [clip(t, NOTE_MAX * 2)] : []; }),
        retire: list('retire').flatMap(item => (isObject(item) && typeof item.id === 'string' ? [{ id: item.id.trim(), why: clip(item.why, 80) }] : (typeof item === 'string' ? [{ id: item.trim(), why: '' }] : []))),
    };
}

export interface AppliedNotes { lines: string[]; added: number; retired: number }

/** 把她的想法落进状态：先放下、再加；now 毫秒 */
export function applyNotesDecision(state: NotesState, decision: NotesDecision, guard: Guard, now: number): AppliedNotes {
    const lines: string[] = [];
    let retired = 0;
    for (const item of decision.retire) {
        const target = state.notes.find(note => note.id === item.id) ?? state.notes.find(note => note.text === item.id);
        if (!target) { lines.push(`没有「${item.id}」这一条，略过`); continue; }
        if (retired >= MAX_RETIRE) { lines.push(`今晚放下的够多了，「${target.text}」留到下次`); continue; }
        if (len(item.why) < 2) { lines.push(`「${target.text}」没说为什么放下，先留着`); continue; }
        state.notes = state.notes.filter(note => note.id !== target.id);
        state.retired = [...state.retired, { at: now, text: target.text, why: item.why }].slice(-30);
        retired++;
        lines.push(`放下「${target.text}」：${item.why}`);
    }
    let added = 0;
    for (const text of decision.add) {
        if (added >= MAX_ADD) { lines.push('今晚加的够多了，剩下的留到下次'); break; }
        const problem = noteProblem(text, state, guard);
        if (problem) {
            state.rejected = [...state.rejected, { at: now, text: clip(text, NOTE_MAX), reason: problem }].slice(-10);
            lines.push(`想写「${clip(text, 30)}」，没成：${problem}`);
            continue;
        }
        let n = 1;
        while (state.notes.some(note => note.id === `n-${dayKey(now)}-${n}`)) n++;
        state.notes.push({ id: `n-${dayKey(now)}-${n}`, text: text.trim(), at: now });
        added++;
        lines.push(`记下一条：${text.trim()}`);
    }
    return { lines, added, retired };
}

// ───────── 想的时候她看到什么 ─────────

export interface ReflectInput {
    char: string;
    user: string;
    /** 人设摘要（卡的 description，宏已替换） */
    persona: string;
    now: number;
    /** 她自己这几天说话的样子 */
    mine: SpeechStats;
    /** 真人女生的样子（语料里数出来的）；没有语料就没有 */
    real?: SpeechStats;
    /** 几条真人的回法（只学口气） */
    samples: readonly Exemplar[];
    /** 最近几次「他说了什么、她怎么回」 */
    exchanges: readonly Exchange[];
    notes: readonly SpeechNote[];
    /** 他最近标过的「像真人」/「这句像 AI」（ADR 0195）；没有就没有 */
    feedback?: FeedbackBundle;
}

export const statsLine = (stats: SpeechStats) => `一次回 ${stats.perTurn} 条；每条中位 ${stats.medianChars} 个字；两个字以内的短反应占 ${pct(stats.shortShare)}；带问号占 ${pct(stats.questionShare)}；带表情占 ${pct(stats.emojiShare)}${tropeLine(stats.tropes) ? `；${tropeLine(stats.tropes)}（只是数字，要不要改你自己定）` : ''}`;

/** 从语料里按日期挑几条（同一天挑同样的，跨天会换） */
export function pickSamples(corpus: readonly Exemplar[], now: number, count = 6): Exemplar[] {
    if (!corpus.length) return [];
    const seed = [...dayKey(now)].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) >>> 0;
    const stride = Math.max(1, Math.floor(corpus.length / count));
    const picked = new Map<number, Exemplar>();
    for (let i = 0; picked.size < Math.min(count, corpus.length) && i < corpus.length * 2; i++) {
        const index = (seed + i * stride) % corpus.length;
        picked.set(index, corpus[index]!);
    }
    return [...picked.values()];
}

export function reflectionMessages(input: ReflectInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const real = input.real ? `\n（真人女生在聊天里的样子，来自 ${input.real.bubbles} 条真实语料：${statsLine(input.real)}。这只是让你看一眼，不是目标线，也不是上限——你想不想变、变多少，你自己定。）` : '';
    const samples = input.samples.length
        ? `\n\n几条真人女生是怎么回的（只看口气、长短、怎么接，别照抄原话）：\n${input.samples.map(item => `他说：${clip(item.said, 40)}\n她回：${item.replied.map(text => clip(text, 40)).join(' / ')}`).join('\n\n')}`
        : '';
    const exchanges = input.exchanges.length
        ? input.exchanges.map(item => `${input.user}：${item.his.map(text => clip(text, 40)).join(' / ')}\n你：${item.hers.map(text => clip(text, 40)).join(' / ')}`).join('\n\n')
        : '（最近没怎么聊）';
    const notes = input.notes.length ? input.notes.map(note => `- ${note.id}｜${note.text}`).join('\n') : '（现在一条都没有）';
    const feedback = input.feedback && feedbackCount(input.feedback) ? `\n\n${feedbackBlock(input.feedback, input.user)}` : '';
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人安静地想一想：自己这几天是怎么说话的、有什么习惯、哪些像自己、哪些想试着改。这是你自己的事，没有人替你定，也不用让谁满意。` },
        { role: 'user', content: `你这几天说话的样子（是从你发的 ${input.mine.bubbles} 条消息里数出来的）：\n${statsLine(input.mine)}${real}${samples}\n\n你最近和${input.user}的几次聊天（他的话只是让你想起当时的情形，别学他的说法）：\n${exchanges}${feedback}\n\n你现在记着的习惯：\n${notes}\n\n你写的这些，他用 /说话习惯 都能看到（他只能看，不能改）。\n\n请只输出一个 JSON 对象（没什么想法就输出 {}），字段都可以省略：\n{"add":[{"text":"我发现……（${NOTE_MIN}–${NOTE_MAX} 字，写你自己怎么说话、想怎么试）"}],"retire":[{"id":"上面某条的 id","why":"为什么不要了"}]}\n\n几条提醒（不是考你）：写的是你自己说话的方式，不写他的口头禅、不引用他的话、不照抄上面真人的句子；这是你自己的观察，不是规定，没有字数线；涉及承认自己是程序、危机、拒绝、骗人的事不通过说话习惯改；一次最多加 ${MAX_ADD} 条、放下 ${MAX_RETIRE} 条；真的没想法就别硬凑。` },
    ];
}

// ───────── 什么时候想 ─────────

/** 夜里（22 点到凌晨 3 点）、距上次想过 ≥ 20 小时、失败后隔 2 小时再试、一天（按日历）最多试 3 次 */
export function reflectionDue(state: Pick<NotesState, 'lastReflectionAt' | 'lastAttemptAt' | 'attempts'>, now: number): boolean {
    const hour = new Date(now).getHours();
    if (hour < REFLECT_FROM_HOUR && hour >= REFLECT_UNTIL_HOUR) return false;
    if (now - state.lastReflectionAt < REFLECT_GAP_MS) return false;
    if (state.lastAttemptAt && now - state.lastAttemptAt < RETRY_GAP_MS) return false;
    return state.attempts.day !== dayKey(now) || state.attempts.n < MAX_ATTEMPTS_PER_DAY;
}

export interface ReflectDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份，函数里自己按时间截） */
    history: () => readonly StoredMessage[];
    /** 真人语料（可以没有） */
    corpus: () => readonly Exemplar[];
    persona: () => string;
    names: { char: string; user: string };
    /** 他最近标过的（ADR 0195）；不传就没有 */
    feedback?: () => FeedbackBundle;
    log: (message: string) => void;
}

export interface ReflectResult { ran: boolean; applied?: AppliedNotes; error?: string }

/** 到点了就想一次（没到点、或最近没怎么说话，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reflectIfDue(deps: ReflectDeps): Promise<ReflectResult> {
    const now = deps.now();
    const state = loadNotesState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const history = deps.history();
    const mine = speechStats(herTurns(history, now));
    if (!mine || mine.bubbles < MIN_BUBBLES) return { ran: false };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveNotesState(deps.dataDir, state);
    try {
        const corpus = deps.corpus();
        const feedback = deps.feedback?.();
        const real = speechStats(corpus.map(item => item.replied));
        const reply = await deps.generate(reflectionMessages({
            char: deps.names.char, user: deps.names.user, persona: deps.persona(), now, mine,
            ...(real ? { real } : {}),
            samples: pickSamples(corpus, now),
            exchanges: recentExchanges(history, now),
            notes: state.notes,
            ...(feedback && feedbackCount(feedback) ? { feedback } : {}),
        }));
        const decision = parseNotesDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadNotesState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyNotesDecision(fresh, decision, { his: [...hisLines(history, now), ...(feedback ? feedbackWhys(feedback) : [])], corpus }, now);
        fresh.lastReflectionAt = now;
        fresh.lastStats = mine;
        saveNotesState(deps.dataDir, fresh);
        deps.log(`说话习惯：晚上想了一次——加 ${applied.added} 条、放下 ${applied.retired} 条${applied.lines.some(line => line.includes('没成')) ? '、有想写没成的' : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`说话习惯：今晚没想成（${detail}），${RETRY_GAP_MS / 3_600_000} 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 / 给他看 ─────────

/** 挑最相关的几条放进提示词：和他这句话的二字词重叠多的排前，同分新的排前；没有重叠就是最近写的几条 */
export function speechNotesLine(notes: readonly SpeechNote[], said: string | undefined, max = LINE_MAX): string | undefined {
    if (!notes.length) return undefined;
    const target = said ? gramSet(said) : new Set<string>();
    const picked = notes
        .map(note => ({ note, score: overlap(target, gramSet(note.text)) }))
        .sort((a, b) => b.score - a.score || b.note.at - a.note.at)
        .slice(0, max)
        .map(item => `- ${item.note.text}`);
    return `[你自己总结过的说话习惯（是你自己的观察，不是规定；看情况自然地用，不用每条都用，也别提这是笔记）：\n${picked.join('\n')}]`;
}

/** /说话习惯 的回复：以「（」开头（运维提示，不进聊天记录）；他只能看，不能改 */
export function describeNotesForOwner(state: NotesState, now: number, feedbackLine?: string): string {
    const ago = (at: number) => { const days = Math.floor((now - at) / 86_400_000); return days <= 0 ? '今天' : `${days} 天前`; };
    const lines = [
        state.notes.length ? `她自己总结的说话习惯（${state.notes.length} 条）：\n${state.notes.map((note, i) => `${i + 1}. ${note.text}（${ago(note.at)}）`).join('\n')}` : '她还没有记下说话习惯（夜里 22 点到凌晨 3 点之间想一次，最近说话够多才会想）。',
        ...(state.retired.length ? [`她放下的：\n${state.retired.slice(-5).map(item => `- ${item.text}（${item.why}）`).join('\n')}`] : []),
        ...(state.rejected.length ? [`她想写、但没成的：\n${state.rejected.slice(-5).map(item => `- ${item.text}（${item.reason}）`).join('\n')}`] : []),
        ...(state.lastStats ? [`上次想的时候，数出来她这几天说话的样子：${statsLine(state.lastStats)}（${state.lastReflectionAt ? ago(state.lastReflectionAt) : ''}）`] : []),
        ...(feedbackLine ? [feedbackLine] : []),
        '这些是她自己的观察，你只能看，不能改；她随时可以放下。',
    ];
    return `（${lines.join('\n\n')}）`;
}

/** 给提示词用的读法：按修改时间缓存（每轮提示词都会读）；读不了就当她还没记过 */
export function speechNotesReader(dataDir: string): () => SpeechNote[] {
    let cached: { key: string; notes: SpeechNote[] } | undefined;
    return () => {
        let key = '-';
        try { const stat = statSync(speechNotesPath(dataDir)); key = `${stat.mtimeMs}:${stat.size}`; } catch { /* 还没有 */ }
        if (cached?.key !== key) cached = { key, notes: loadNotesState(dataDir).notes };
        return cached.notes;
    };
}
