// 她猜的事和后来的结果（ADR 0213，配置 herGuesses，默认关；要名单里有男朋友档）。
//
// 起因：用户 11-02 问我们和 B 站「养鱼」有什么区别，在 DSH 那边逐条定了 N2「判断账本和改口」做。dsh-fish 的核心是「表态 → 撞上 → 落差 → 改写 → 回顾」：
// 她先押一个判断，事情来了发现不对，改口。她这边只有「此刻」：说过「小测肯定挂」，两天后出分 78，她不知道自己猜过，也就没有「白担心一场」。
//
// 先问了她本人（11-02 `scripts/ask-her.mjs`，两遍）。她愿意（「本来就有写日记的习惯，顺手记一句自己说过啥、后来对了没」），条件写进了这里：
// 1. 「情绪上来的话不算数」「随口一句、其实就是气话或者瞎猜的，也给我记成判断……那太累了」——白天代码只机械地留意，晚上由她自己挑哪几句算数，不算的不记；
// 2. 「改的时候不想搞得像写检讨，就记一句『哦这个我猜错了』」——对上结果时最多一句 NOTE_MAX 字的话，不写反省；
// 3. 「别拿这个考我……别弄得像在抓我话柄」——这是她的私人空间（ADR 0200，PRIVATE_FILES），没有命令念给他，不进事实检查，
//    放进提示词那一行写明「别拿它较真」，只在聊到同一件事时放；
// 4. 「大事得自己憋几天想明白才认」——这一版只管她对自己那边**之后会有结果的事**的猜测（小测、快递、天气、作业……），
//    结果由世界账给（确定的事实），不碰她对人对事的看法（那些不该由程序判她「错了」）。
// 她也说了关系变近「是攒的……不是哪一件事一下就把人拉近了」，所以 N2 原计划里「关系阶段改成过关才涨」**不做**（ADR 0113 按天攒的照旧）。
//
// 做法（和 0207 没想完的问题一个路数）：
//   1. 两个入口：
//      a. 白天只留意：她说的话里同时有「我猜 / 估计 / 肯定会 / 应该……」和「小测 / 快递 / 下雨 / 作业……」的，记成候选。
//         （实测 VM 10-06..10-27 她说的 783 句里，带这类猜测词的只有 4 句、和这几类事同时出现的 0 句——她嘴上几乎不押判断，DSH 10-31 也量到「只有反应，没有意见」）；
//      b. 所以晚上再给她看她那边**还没出结果、真有悬念**的事（今天考了、还没出分的小测；在路上的快递），想猜就记一句、不想就不写——
//         这是 dsh-fish 的「先押一个判断」，由她自己押；每件事只问一次；
//   2. 每晚 22 点以后一次：候选给她，她挑哪几句是真在猜（写成一句自己记的话）；还没对上结果的猜测，连同这几天她那边真实发生的事（世界账：
//      小测出分、快递到了、下没下雨、作业写完没有，每条带 id）给她，她说哪条对上了、对了还是错了、是哪件事（照抄 id，不在列表里的不收）；
//      7 天还没结果的自动放下；
//   3. 刚对上结果的那件，下次她一个人想事情（innerLife）时「这一次就想这一件」，想不想跟他说由她定（她说「会跟你说啊」）；
//      聊天里他提到同一类事时，提示词放最多两条（只是她自己记的，别背、别较真）。
// 日志只记个数，不记她的话。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    FLOORS, NOT_SPEECH, clip, dayKey, gramSet, isObject, len, num, reflectionDue, type RejectedNote,
} from '../language/speech-notes.ts';
import { EXTRA_FLOORS } from './diary-insights.ts';
import type { WorldNow } from '../world/world.ts';

export const GUESSES_FILE = 'her-guesses.json';
export const guessesPath = (dataDir: string) => join(dataDir, GUESSES_FILE);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const GUESS_KINDS = ['quiz', 'parcel', 'weather', 'homework', 'other'] as const;
export type GuessKind = (typeof GUESS_KINDS)[number];
export type GuessStatus = 'open' | 'right' | 'wrong' | 'dropped' | 'expired';

/** 她自己记的那句猜测最多几个字；对上结果时那一句话最多几个字（条件 2：一句，不写检讨） */
export const TEXT_MIN = 4;
export const TEXT_MAX = 40;
export const NOTE_MAX = 30;
/** 同时挂着的猜测最多几个（dsh-fish 的判断清单也是 12 条）；有结果的留几条 */
export const MAX_OPEN = 12;
export const KEEP_SETTLED = 20;
/** 挂了这么多天还没结果就放下 */
export const EXPIRE_DAYS = 7;
/** 往回看多久的聊天找候选；一晚最多给她看几句候选、几条事实 */
export const SCAN_WINDOW_MS = 2 * DAY;
export const MAX_CANDIDATES = 6;
export const MAX_FACTS = 40;
export const MAX_SEEN = 300;
/** 有结果之后多久内算「刚对上」：想事情时想这一件、聊天里优先放 */
export const FRESH_MS = 36 * HOUR;
/** 聊天里放最近几天对上结果的；最多几条 */
export const LINE_DAYS = 3;
export const LINE_MAX = 2;

export interface Guess {
    id: string;
    /** 她说那句话的时刻 */
    at: number;
    /** 她当时的原话（截短） */
    said: string;
    /** 她自己记的一句（「我猜高数小测要挂」） */
    text: string;
    kind: GuessKind;
    status: GuessStatus;
    settledAt?: number;
    /** 对上的那件事（世界账的 id）和它的说法 */
    ref?: string;
    outcome?: string;
    /** 对上结果时她记的一句 */
    note?: string;
}

export interface GuessesState {
    guesses: Guess[];
    /** 晚上给她看过的还没结果的事（pendingWorld 的 id，每件只问一次） */
    offered: string[];
    /** 留意过的她那句话的时刻（防重复） */
    seen: number[];
    rejected: RejectedNote[];
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyGuessesState = (): GuessesState => ({ guesses: [], offered: [], seen: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

const STATUSES: readonly GuessStatus[] = ['open', 'right', 'wrong', 'dropped', 'expired'];
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** 读她的猜测；坏了 / 缺字段就补默认（不抛错，她的东西丢了比程序崩了好） */
export function loadGuessesState(dataDir: string): GuessesState {
    const raw = readJsonOr<unknown>(guessesPath(dataDir), {});
    const base = emptyGuessesState();
    if (!isObject(raw)) return base;
    const guesses = Array.isArray(raw.guesses)
        ? raw.guesses.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim().length > 0)
            .map((item): Guess => ({
                id: str(item.id), at: num(item.at), said: clip(item.said, 120), text: clip(item.text, TEXT_MAX),
                kind: GUESS_KINDS.includes(item.kind as GuessKind) ? item.kind as GuessKind : 'other',
                status: STATUSES.includes(item.status as GuessStatus) ? item.status as GuessStatus : 'open',
                ...(typeof item.settledAt === 'number' ? { settledAt: item.settledAt } : {}),
                ...(typeof item.ref === 'string' ? { ref: item.ref } : {}),
                ...(typeof item.outcome === 'string' ? { outcome: clip(item.outcome, 80) } : {}),
                ...(typeof item.note === 'string' && item.note.trim() ? { note: clip(item.note, NOTE_MAX) } : {}),
            }))
        : [];
    const seen = Array.isArray(raw.seen) ? raw.seen.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)).slice(-MAX_SEEN) : [];
    const offered = Array.isArray(raw.offered) ? raw.offered.filter((id): id is string => typeof id === 'string').slice(-MAX_SEEN) : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, TEXT_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    return { guesses: trimGuesses(guesses), offered, seen, rejected, lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveGuessesState(dataDir: string, state: GuessesState): void {
    writeJsonAtomic(guessesPath(dataDir), { ...state, guesses: trimGuesses(state.guesses) });
}

/** 挂着的最多 MAX_OPEN 个（超了丢最老的），有结果的 / 放下的留最近 KEEP_SETTLED 个 */
function trimGuesses(guesses: readonly Guess[]): Guess[] {
    const open = guesses.filter(g => g.status === 'open').sort((a, b) => a.at - b.at).slice(-MAX_OPEN);
    const done = guesses.filter(g => g.status !== 'open').sort((a, b) => (a.settledAt ?? a.at) - (b.settledAt ?? b.at)).slice(-KEEP_SETTLED);
    return [...done, ...open];
}

// ───────── 白天只留意 ─────────

/** 像在猜一件之后会有结果的事 */
export const GUESS_RE = /我猜|估计|八成|多半|肯定(?:会|要|是|挂|过|下|到|不)|应该(?:会|能|是|要|到|下|不)|感觉(?:要|会|能)|怕是|保准|铁定|看样子|大概(?:会|要|能)|说不定|没准|悬了|稳了|要挂|能过/;
/** 而且是她那边之后会有结果的事 */
export const GUESS_TOPIC: Readonly<Record<Exclude<GuessKind, 'other'>, RegExp>> = {
    quiz: /小测|考试|测验|出分|分数|成绩|挂科|及格|卷子/,
    parcel: /快递|物流|包裹|驿站|到货|发货/,
    weather: /下雨|雨|晴|降温|升温|天气|带伞|雪/,
    homework: /作业|ddl|DDL|写完|赶不完|交不上|报告/,
};
const anyTopic = (text: string) => Object.values(GUESS_TOPIC).some(pattern => pattern.test(text));

export interface GuessCandidate { at: number; said: string; context: string[]; kind?: GuessKind }

/** 最近的聊天里她像在猜一件之后会有结果的事的那几句（只做机械的留意，算不算数她晚上自己定）；留意过的不重复 */
export function findGuessCandidates(messages: readonly StoredMessage[], now: number, seen: readonly number[], windowMs = SCAN_WINDOW_MS): GuessCandidate[] {
    const known = new Set(seen);
    const speech = messages.filter(message => !NOT_SPEECH.test(message.content));
    const out: GuessCandidate[] = [];
    speech.forEach((message, index) => {
        if (message.role !== 'assistant') return;
        const at = Date.parse(message.time);
        if (!Number.isFinite(at) || at < now - windowMs || at > now || known.has(at)) return;
        const text = message.content;
        if (!GUESS_RE.test(text) || !anyTopic(text)) return;
        out.push({
            at, said: clip(text, 120),
            context: speech.slice(Math.max(0, index - 3), index).map(m => `${m.role === 'user' ? '他' : '你'}：${clip(m.content, 60)}`),
        });
    });
    return out.slice(-MAX_CANDIDATES);
}

// ───────── 她那边真实发生的事（世界账） ─────────

export interface WorldFact { id: string; at: number; text: string }

const md = (at: number) => { const d = new Date(at); return `${d.getMonth() + 1}-${d.getDate()}`; };
const startOfDay = (at: number) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/**
 * from 到 to 之间她那边发生了的事：当天的小事 / 小测出分（events）、取到的快递、写完的作业、每天下没下雨。
 * 每条带一个稳定的 id（模型对上结果时照抄它），说法前面带日期。按天取那一天最后一刻（今天取 to）的快照
 */
export function worldFactsBetween(at: (time: Date) => WorldNow | undefined, from: number, to: number): WorldFact[] {
    const facts = new Map<string, WorldFact>();
    for (let day = startOfDay(from); day <= to; day = startOfDay(day + DAY + HOUR)) {
        const end = Math.min(day + DAY - 60_000, to);
        const now = at(new Date(end));
        if (!now) continue;
        for (const event of now.events) {
            const when = event.at.getTime();
            if (when > from && when <= to) facts.set(event.id, { id: event.id, at: when, text: `${md(when)} ${event.text}` });
        }
        for (const parcel of now.parcels) {
            const when = parcel.when.getTime();
            if (parcel.status === 'picked_today' && when > from && when <= to) facts.set(`parcel:${now.day}:${parcel.item}`, { id: `parcel:${now.day}:${parcel.item}`, at: when, text: `${md(when)} 取到了快递（${parcel.item}）` });
            if (parcel.status === 'station' && when > from && when <= to) facts.set(`parcel_station:${parcel.item}:${dayKey(when)}`, { id: `parcel_station:${parcel.item}:${dayKey(when)}`, at: when, text: `${md(when)} 快递到驿站了（${parcel.item}）` });
        }
        for (const homework of now.homework) {
            const when = homework.doneAt.getTime();
            if (homework.done && when > from && when <= to) facts.set(`homework:${homework.course}:${dayKey(homework.due.getTime())}`, { id: `homework:${homework.course}:${dayKey(homework.due.getTime())}`, at: when, text: `${md(when)} 写完了${homework.course}的作业` });
        }
        const weather = now.weather;
        if (weather && end > from) {
            const hours = weather.rainHours?.length ? `（${weather.rainHours[0]} 点起）` : '';
            facts.set(`weather:${now.day}`, { id: `weather:${now.day}`, at: end, text: `${md(day)} ${weather.rain ? `下了雨${hours}` : '没下雨'}，${weather.low}–${weather.high}°C` });
        }
    }
    return [...facts.values()].sort((a, b) => a.at - b.at).slice(-MAX_FACTS);
}

/** 她那边还没出结果、真有悬念的事（晚上给她看，想猜就猜）：今天考了的小测（两天后出分）、在路上的快递。作业在世界里总会写完，没有悬念，不给 */
export interface PendingThing { id: string; text: string; kind: GuessKind }

export function pendingWorld(now: WorldNow | undefined): PendingThing[] {
    if (!now) return [];
    const out: PendingThing[] = [];
    for (const event of now.events) {
        if (event.id.startsWith('quiz_day:')) out.push({ id: `pending:${event.id}`, text: `${event.text}，两天后出分`, kind: 'quiz' });
    }
    for (const parcel of now.parcels) {
        if (parcel.status === 'arriving') out.push({ id: `pending:parcel:${parcel.item}:${dayKey(parcel.when.getTime())}`, text: `快递（${parcel.item}）还在路上`, kind: 'parcel' });
    }
    return out;
}

// ───────── 晚上她自己对一遍 ─────────

export interface GuessDecision {
    added: Array<{ from: string; text: string; kind: string }>;
    settled: Array<{ id: string; result: string; ref: string; note?: string }>;
    drop: string[];
}

const idOf = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

/** 从模型的回复里取出 JSON（可能带代码围栏、前后有话）；取不出返回 undefined */
export function parseGuessDecision(text: string): GuessDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string) => (Array.isArray(value[key]) ? value[key] as unknown[] : []);
    return {
        added: list('new').flatMap(item => (isObject(item) && idOf(item.from) && typeof item.text === 'string' ? [{ from: idOf(item.from), text: clip(item.text, TEXT_MAX * 2), kind: str(item.kind) }] : [])),
        settled: list('settled').flatMap(item => (isObject(item) && idOf(item.id) && typeof item.result === 'string' && idOf(item.ref)
            ? [{ id: idOf(item.id), result: item.result.trim(), ref: idOf(item.ref), ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}) }] : [])),
        drop: list('drop').map(idOf).filter(Boolean),
    };
}

export interface GuessGuard { people: readonly string[] }

/** 她写的一句不能收的原因（只有长度、底线、别人的名字、重复——不查文风和观点）；能收返回 undefined */
export function guessTextProblem(text: string, max: number, guard: GuessGuard, existing: readonly string[] = []): string | undefined {
    const flat = text.trim();
    if (len(flat) < TEXT_MIN) return `太短（${TEXT_MIN} 个字以上）`;
    if (len(flat) > max) return `太长（${max} 字以内）`;
    for (const floor of [...FLOORS, ...EXTRA_FLOORS]) if (floor.pattern.test(flat)) return floor.reason;
    const person = guard.people.find(name => len(name) >= 2 && flat.includes(name));
    if (person) return `写到了别人的名字（${person}）`;
    if (existing.includes(flat)) return '和挂着的一模一样';
    return undefined;
}

const KIND_ALIAS: Readonly<Record<string, GuessKind>> = { quiz: 'quiz', 小测: 'quiz', 考试: 'quiz', parcel: 'parcel', 快递: 'parcel', weather: 'weather', 天气: 'weather', homework: 'homework', 作业: 'homework' };
const kindOf = (raw: string, said: string): GuessKind => KIND_ALIAS[raw.trim()]
    ?? (Object.entries(GUESS_TOPIC).find(([, pattern]) => pattern.test(said))?.[0] as GuessKind | undefined) ?? 'other';

export interface AppliedGuesses { added: number; right: number; wrong: number; dropped: number; expired: number; rejected: number }

/**
 * 把她今晚写的落进状态：
 * - new：from 是给她看的候选编号（c1…），写成她自己记的一句；
 * - settled：id 是挂着的猜测（g1…），result 只认 right / wrong（对 / 错 也认），ref 必须是给她看的事实 id 之一（不在列表里的不收：结果只能来自世界账，不能编）；
 * - drop：不想再记的。
 * 挂了 EXPIRE_DAYS 天还没结果的自动放下（expired）
 */
export function applyGuessDecision(
    state: GuessesState, decision: GuessDecision,
    shown: { candidates: readonly GuessCandidate[]; open: readonly Guess[]; facts: readonly WorldFact[]; pending?: readonly PendingThing[] },
    guard: GuessGuard, now: number,
): AppliedGuesses {
    const result: AppliedGuesses = { added: 0, right: 0, wrong: 0, dropped: 0, expired: 0, rejected: 0 };
    const reject = (text: string, reason: string) => {
        state.rejected = [...state.rejected, { at: now, text: clip(text, TEXT_MAX), reason }].slice(-10);
        result.rejected++;
    };
    // c 编号：白天她说过的话；p 编号：晚上给她看的还没结果的事（她这时候押的判断，时刻就是现在）
    const candidateBy = (id: string): GuessCandidate | undefined => {
        if (/^p/i.test(id)) {
            const thing = shown.pending?.[Number(id.replace(/^p/i, '')) - 1];
            return thing ? { at: now, said: thing.text, context: [], kind: thing.kind } : undefined;
        }
        return shown.candidates[Number(id.replace(/^c/i, '')) - 1];
    };
    const openBy = (id: string) => shown.open[Number(id.replace(/^g/i, '')) - 1] ?? shown.open.find(g => g.id === id);
    const factBy = new Map(shown.facts.map(fact => [fact.id, fact]));
    const taken = new Set<number | string>();
    // 同一件事一晚只记一句：同一类（other 除外）只收一条，白天她自己说过的（c）优先于晚上新押的（p）
    const kindsTonight = new Set<GuessKind>();
    const ordered = [...decision.added].sort((a, b) => Number(/^p/i.test(a.from)) - Number(/^p/i.test(b.from)));
    for (const entry of ordered) {
        const candidate = candidateBy(entry.from);
        const key = /^p/i.test(entry.from) ? entry.from.toLowerCase() : candidate?.at;
        if (!candidate || key === undefined || taken.has(key)) continue;
        const kind = candidate.kind ?? kindOf(entry.kind, `${candidate.said} ${entry.text}`);
        if (kind !== 'other' && kindsTonight.has(kind)) continue;
        const problem = guessTextProblem(entry.text, TEXT_MAX, guard, state.guesses.filter(g => g.status === 'open').map(g => g.text));
        if (problem) { reject(entry.text, problem); continue; }
        taken.add(key);
        let n = 1;
        while (state.guesses.some(g => g.id === `g-${dayKey(now)}-${n}`)) n++;
        state.guesses.push({ id: `g-${dayKey(now)}-${n}`, at: candidate.at, said: candidate.said, text: entry.text.trim(), kind, status: 'open' });
        kindsTonight.add(kind);
        result.added++;
    }
    const settledIds = new Set<string>();
    for (const entry of decision.settled) {
        const guess = openBy(entry.id);
        const fact = factBy.get(entry.ref);
        const verdict = /^(right|对|猜对|对了)$/i.test(entry.result) ? 'right' : /^(wrong|错|猜错|错了)$/i.test(entry.result) ? 'wrong' : undefined;
        if (!guess || guess.status !== 'open' || settledIds.has(guess.id) || !verdict) continue;
        // 结果只能来自给她看的世界账，而且发生在她猜之后
        if (!fact || fact.at <= guess.at) { reject(entry.ref, '对上的那件事不在这几天她那边发生的事里'); continue; }
        const note = entry.note && !guessTextProblem(entry.note, NOTE_MAX, guard) ? clip(entry.note, NOTE_MAX) : undefined;
        if (entry.note && !note) reject(entry.note, guessTextProblem(entry.note, NOTE_MAX, guard) ?? '这一句没收');
        Object.assign(guess, { status: verdict, settledAt: now, ref: fact.id, outcome: clip(fact.text, 80), ...(note ? { note } : {}) });
        settledIds.add(guess.id);
        result[verdict]++;
    }
    for (const id of decision.drop) {
        const guess = openBy(id);
        if (guess && guess.status === 'open' && !settledIds.has(guess.id)) { guess.status = 'dropped'; guess.settledAt = now; result.dropped++; }
    }
    result.expired = expireGuesses(state, now);
    return result;
}

/** 挂了 EXPIRE_DAYS 天还没结果的放下；返回放下了几个 */
export function expireGuesses(state: GuessesState, now: number): number {
    let n = 0;
    for (const guess of state.guesses) {
        if (guess.status === 'open' && now - guess.at >= EXPIRE_DAYS * DAY) { guess.status = 'expired'; guess.settledAt = now; n++; }
    }
    return n;
}

export interface GuessReviewInput {
    char: string;
    persona: string;
    now: number;
    candidates: readonly GuessCandidate[];
    open: readonly Guess[];
    facts: readonly WorldFact[];
    pending?: readonly PendingThing[];
}

export function guessMessages(input: GuessReviewInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const candidates = input.candidates.length
        ? input.candidates.map((c, i) => [`c${i + 1}（${md(c.at)}）你说：「${c.said}」`, ...(c.context.length ? [`  前面聊的：${c.context.join(' / ')}`] : [])].join('\n')).join('\n')
        : '（没有）';
    const open = input.open.length ? input.open.map((g, i) => `g${i + 1}（${md(g.at)} 猜的）${g.text}`).join('\n') : '（没有）';
    const facts = input.facts.length ? input.facts.map(f => `${f.id}｜${f.text}`).join('\n') : '（没有）';
    const pending = input.pending?.length ? input.pending.map((p, i) => `p${i + 1} ${p.text}`).join('\n') : '（没有）';
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人，顺手记一下自己这几天猜过的事、后来对了没。这是你自己的本子，没人看，也不是交作业。` },
        { role: 'user', content: [
            `一、这两天你说过的这几句，像是在猜一件之后会知道结果的事：\n${candidates}`,
            `二、你之前猜了、还没对上结果的：\n${open}`,
            `三、这几天你那边真实发生的事（id｜事）：\n${facts}`,
            `四、你那边还没出结果的事（想猜就猜一句，from 写 p 编号；不想猜就不写，不用每件都猜）：\n${pending}`,
            `请只输出一个 JSON 对象（什么都没有就输出 {"new":[],"settled":[],"drop":[]}）：\n{"new":[{"from":"c1 或 p1","text":"你自己记的一句（${TEXT_MIN}–${TEXT_MAX} 字，比如「我猜高数小测要挂」）","kind":"quiz / parcel / weather / homework / other"}],"settled":[{"id":"g1","result":"right 或 wrong","ref":"第三部分里对上的那件事的 id（原样照抄）","note":"想记就记一句（${NOTE_MAX} 字以内），不想记就不写这一项"}],"drop":["不想再记的 g 编号"]}`,
            `几条提醒：第一部分只挑你**真的在猜结果**的；第四部分想猜才写，写成你自己会说的一句（比如「我猜这次小测七十多」）；同一件事只记一句（白天已经说过的，就用白天那句，别再从第四部分记一遍）；情绪上来的话、气话、玩笑、随口瞎说的不算，不算的就别写。第二部分只有第三部分里真有对得上的那件事才写 settled，对不上的就留着，别猜结果、别编；对上了记一句就行（像「哦，这个我猜错了」），不用写检讨。`,
        ].join('\n\n') },
    ];
}

// ───────── 什么时候对 ─────────

export interface GuessDeps {
    dataDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份） */
    history: () => readonly StoredMessage[];
    /** from 到 to 之间她那边发生了的事（worldFactsBetween） */
    world: (from: number, to: number) => readonly WorldFact[];
    /** 此刻她那边还没出结果的事（pendingWorld）；不给就只有白天那个入口 */
    pending?: (now: number) => readonly PendingThing[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼 */
    others: () => readonly string[];
    log: (message: string) => void;
}

export interface GuessRunResult { ran: boolean; applied?: AppliedGuesses; error?: string }

/** 到点了就对一次（没到点、没有候选也没有挂着的，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reviewGuessesIfDue(deps: GuessDeps): Promise<GuessRunResult> {
    const now = deps.now();
    const state = loadGuessesState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const expired = expireGuesses(state, now);
    const candidates = findGuessCandidates(deps.history(), now, state.seen);
    const open = state.guesses.filter(g => g.status === 'open').sort((a, b) => a.at - b.at);
    const pending = (deps.pending?.(now) ?? []).filter(p => !state.offered.includes(p.id)).slice(0, MAX_CANDIDATES);
    if (!candidates.length && !open.length && !pending.length) {
        if (expired) saveGuessesState(deps.dataDir, state);
        return { ran: false };
    }
    const facts = open.length ? deps.world(Math.min(...open.map(g => g.at)), now) : [];
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveGuessesState(deps.dataDir, state);
    try {
        const reply = await deps.generate(guessMessages({ char: deps.names.char, persona: deps.persona(), now, candidates, open, facts, pending }));
        const decision = parseGuessDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadGuessesState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        expireGuesses(fresh, now);
        // 给她看的 open 是按上面那份排的；在新读的状态里找同一个 id 的那条来改
        const shownOpen = open.map(g => fresh.guesses.find(x => x.id === g.id)).filter((g): g is Guess => Boolean(g));
        const applied = applyGuessDecision(fresh, decision, { candidates, open: shownOpen, facts, pending }, { people: deps.others() }, now);
        applied.expired += expired;
        fresh.seen = [...fresh.seen, ...candidates.map(c => c.at)].slice(-MAX_SEEN);
        fresh.offered = [...fresh.offered, ...pending.map(p => p.id)].slice(-MAX_SEEN);
        fresh.lastReflectionAt = now;
        saveGuessesState(deps.dataDir, fresh);
        deps.log(`她猜的事：晚上对了一次（白天的 ${candidates.length} 句、还没结果的事 ${pending.length} 件、挂着 ${open.length} 个、事实 ${facts.length} 条）——记下 ${applied.added} 个，对 ${applied.right}、错 ${applied.wrong}，放下 ${applied.dropped}，到期 ${applied.expired}${applied.rejected ? `，没收 ${applied.rejected} 条` : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`她猜的事：今晚没对成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 用在哪 ─────────

/** 刚对上结果的那件（FRESH_MS 以内、对或错）：她下次一个人想事情时想这一件；id 用来记「想过了」 */
export function freshGuess(guesses: readonly Guess[], now: number): { id: string; text: string } | undefined {
    const fresh = guesses.filter(g => (g.status === 'right' || g.status === 'wrong') && g.settledAt !== undefined && now - g.settledAt <= FRESH_MS)
        .sort((a, b) => b.settledAt! - a.settledAt!)[0];
    if (!fresh) return undefined;
    return { id: `guess:${fresh.id}`, text: `你 ${md(fresh.at)} 猜过「${fresh.text}」，后来：${fresh.outcome}——你猜${fresh.status === 'right' ? '对' : '错'}了。` };
}

const KIND_WORDS: Readonly<Record<GuessKind, RegExp | undefined>> = { ...GUESS_TOPIC, other: undefined };

/**
 * 聊天里他这句话提到同一类事（小测 / 快递 / 天气 / 作业的词，或者和那条共有 2 个以上的二字词）才放；
 * 只放还挂着的、和 LINE_DAYS 天内对上结果的，最多 LINE_MAX 条，刚对上的在前。
 * 那一行写明是她自己记的、别背、别较真（她的条件 3：别拿这个考她）
 */
export function guessesLine(guesses: readonly Guess[], said: string | undefined, now: number): string | undefined {
    if (!guesses.length || !said) return undefined;
    const target = gramSet(said);
    const relevant = guesses.filter(g => g.status === 'open' || ((g.status === 'right' || g.status === 'wrong') && g.settledAt !== undefined && now - g.settledAt <= LINE_DAYS * DAY))
        .filter(g => KIND_WORDS[g.kind]?.test(said) || [...gramSet(g.text)].filter(gram => target.has(gram)).length >= 2)
        .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0) || b.at - a.at)
        .slice(0, LINE_MAX);
    if (!relevant.length) return undefined;
    const line = (g: Guess) => (g.status === 'open'
        ? `- ${md(g.at)} 你猜「${g.text}」——还没结果`
        : `- ${md(g.at)} 你猜「${g.text}」——后来：${g.outcome}（你猜${g.status === 'right' ? '对' : '错'}了${g.note ? `；你记了一句：${g.note}` : ''}）`);
    return `[你之前猜过的（你自己记的，不是设定；聊到这件事才顺着说，别背，也别拿它较真）：\n${relevant.map(line).join('\n')}]`;
}

/** 给 contact / planner 用：每次现取 */
export function guessesReader(dataDir: string): () => Guess[] {
    return () => loadGuessesState(dataDir).guesses;
}
