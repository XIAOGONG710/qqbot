// 小梗回头提（ADR 0114，配置 jokes，默认关）：情侣之间有只有你们懂的玩笑——一个词、一句话反复出现，当时两个人都笑了。
// 她原来的“记得”是事实（长期记忆）：没有“我们的梗”这一层，所以不会过几天自己回头提一句。
// 做法：隔一阵让模型从最近两周的聊天里挑最多 3 个梗（后台抽取，和待跟进、答应的事同一种做法）；代码硬校验——梗必须是聊天里**原样出现过至少两次**的词 / 短句，
// 编出来的（原文里找不到的）一律丢掉；存在 <数据目录>/jokes/<QQ>.json（可以随时删，会重新抽）。
// 用的时候：聊天提示词里偶尔（约 1/4 的轮次）多一行“你们之间有个梗 X，话赶话正好接得上就顺口提一句”；她 72 小时内刚用过的不再给；他难过 / 危机 / 小别扭时不给。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export interface Joke {
    /** 原样出现在聊天里的词 / 短句 */
    phrase: string;
    /** 一句话说怎么来的 */
    origin: string;
}
export interface JokeState {
    version: 1;
    jokes: Joke[];
    /** 上一次抽取的时刻（ISO） */
    updatedAt?: string;
    /** 上一次抽取时聊天记录一共多少条 */
    messageCount?: number;
    /** 上次处理的末条消息摘要，不保存聊天正文。旧文件下一次正常刷新时补齐。 */
    messageCursor?: string;
    /** null means an explicitly present but invalid manifest, never legacy. */
    source?: JokeSource | null;
}

export interface JokeSource {
    version: 1;
    count: number;
    historyHash: string;
    /** Fingerprint of the complete actual model messages, not reconstructed at read time. */
    requestHash: string;
    jokesHash: string;
}

/** 多久看一眼该不该抽（抽不抽由下面的条件定） */
export const JOKES_CHECK_MS = 6 * HOUR;
/** 隔多久最多抽一次 */
export const JOKES_REFRESH_MS = 20 * HOUR;
/** 最近这么多天的聊天拿去抽 */
export const JOKES_WINDOW_DAYS = 14;
/** 窗口里至少这么多条才抽（太少看不出梗） */
export const JOKES_MIN_MESSAGES = 40;
/** 比上次抽取至少多这么多条新消息才再抽 */
export const JOKES_MIN_NEW = 12;
/** 最多留几个 */
export const JOKES_KEPT = 3;
/** 梗至少在聊天里出现几次（不同的消息） */
export const JOKE_MIN_OCCURRENCES = 2;
/** 这一轮给她看梗的概率（按他最后一句取哈希） */
export const JOKE_TURN_SHARE = 0.25;
/** 她自己最近这么久之内说过就不再给 */
export const JOKE_COOLDOWN_MS = 72 * HOUR;

type Said = { role: 'user' | 'assistant'; content: string; time?: string };
const cursorOf = (message: Said) => createHash('sha256').update(JSON.stringify([message.time, message.role, message.content])).digest('hex');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const historyHash = (messages: readonly Said[]) => digest(messages.map(message => [message.role, message.time, message.content]));
const jokesHash = (jokes: readonly Joke[]) => digest(jokes.map(joke => [joke.phrase, joke.origin]));
const validSource = (value: unknown): value is JokeSource => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const source = value as Partial<JokeSource>;
    return source.version === 1 && Number.isSafeInteger(source.count) && source.count! >= JOKES_MIN_MESSAGES
        && [source.historyHash, source.requestHash, source.jokesHash].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
};
const sourceMatches = (state: JokeState, history: readonly Said[]): boolean => validSource(state.source)
    && state.source.count <= history.length
    && state.source.jokesHash === jokesHash(state.jokes)
    && state.source.historyHash === historyHash(history.slice(0, state.source.count));

/** Read protection also applies after restart. Unknown legacy provenance is
 * preserved on disk but is not evidence that an origin is still permitted. */
export function verifiedJokes(state: JokeState, history: readonly Said[]): Joke[] {
    return sourceMatches(state, history) ? state.jokes : [];
}

export const jokesPrompt = (userName: string, charName: string, transcript: string) => `下面是${charName}和${userName}最近两周的聊天。请找出他们之间的“小梗”：一个词或一句短话，在聊天里**反复出现**（至少两次），并且当时双方在玩、在笑，是只有他们俩懂的玩笑。
要求：
- 只输出一个 JSON 数组，最多 3 个：[{"梗":"聊天里原样出现的词或短句（2–12 个字）","来历":"一句话说清怎么来的（不超过 30 字）"}]；没有就输出 []。
- “梗”必须是聊天原文里**原样**出现过的字，不许改写、不许自己概括、不许编。
- 不要选日常词（吃饭、晚安、哈哈）、不要选带真名 / 地址 / 电话 / 病情的。
聊天：
${transcript}`;

/** 把模型的回复解析成梗，并硬校验：梗要在聊天里原样出现至少 JOKE_MIN_OCCURRENCES 条不同的消息；2–12 个字；来历 ≤ 40 字 */
export function parseJokes(reply: string, history: readonly Said[]): Joke[] {
    const match = /\[[\s\S]*\]/.exec(reply);
    if (!match) return [];
    let raw: unknown;
    try { raw = JSON.parse(match[0]); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const out: Joke[] = [];
    for (const item of raw) {
        const o = item as Record<string, unknown> | null;
        const phrase = typeof o?.['梗'] === 'string' ? o['梗'].trim() : '';
        const origin = typeof o?.['来历'] === 'string' ? o['来历'].trim() : '';
        const length = [...phrase].length;
        if (length < 2 || length > 12 || !origin || [...origin].length > 40) continue;
        if (/^\d+$/.test(phrase) || /\d{6,}/.test(phrase)) continue;
        const occurrences = history.filter(message => message.content.includes(phrase)).length;
        if (occurrences < JOKE_MIN_OCCURRENCES) continue;
        if (out.some(joke => joke.phrase === phrase)) continue;
        out.push({ phrase, origin });
        if (out.length >= JOKES_KEPT) break;
    }
    return out;
}

export interface JokeStoreOptions {
    dir: string;
    log: (message: string) => void;
}

export interface JokeStore {
    load(qq: number): JokeState;
    save(qq: number, state: JokeState): void;
}

export function jokeStore(options: JokeStoreOptions): JokeStore {
    const file = (qq: number) => join(options.dir, `${qq}.json`);
    const unavailable = (qq: number) => {
        try { options.log(`小梗：${qq} 的文件或来源清单读不了，保留原文件，暂停供给和刷新`); }
        catch { /* 诊断不能把未知来源降级成可重建的空白 legacy。 */ }
    };
    return {
        load(qq) {
            const path = file(qq);
            try {
                const value = JSON.parse(readFileSync(path, 'utf8')) as JokeState;
                if (value?.version !== 1 || !Array.isArray(value.jokes)) throw new Error('结构不对');
                const state = { ...value, jokes: value.jokes.filter(j => typeof j?.phrase === 'string' && typeof j.origin === 'string') };
                if (Object.hasOwn(value, 'source') && (!validSource(value.source) || value.source.jokesHash !== jokesHash(state.jokes))) {
                    state.source = null;
                    unavailable(qq);
                }
                return state;
            } catch (error) {
                if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { version: 1, jokes: [] };
                unavailable(qq);
                return { version: 1, jokes: [], source: null };
            }
        },
        save(qq, state) {
            mkdirSync(options.dir, { recursive: true });
            const tmp = `${file(qq)}.tmp`;
            writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            renameSync(tmp, file(qq));
        },
    };
}

export interface RefreshOptions {
    qq: number;
    userName: string;
    charName: string;
    history: readonly Said[];
    store: JokeStore;
    /** 调模型：返回原文 */
    extract: (messages: { role: 'user'; content: string }[]) => Promise<string>;
    now: number;
    log: (message: string) => void;
    /** Owner cancellation closes local work; an uncooperative model may finish later. */
    signal?: AbortSignal;
    /** Re-read the same contact/tier view. Appends are safe; changed or missing
     * source messages invalidate this extraction before dispatch or commit. */
    freshHistory?: () => readonly Said[];
}

/** Background host owner. Stop closes entry synchronously and drains the local
 * jobs after their model waits are cancelled, without waiting for the provider. */
export function jokeRefresher() {
    const lifetime = new AbortController(), jobs = new Set<Promise<boolean>>();
    let drain: Promise<void> | undefined;
    return {
        refresh(options: RefreshOptions): Promise<boolean> {
            if (lifetime.signal.aborted) return Promise.resolve(false);
            const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
            const frozen = { ...options, history: options.history.map(message => ({ ...message })), signal };
            const task = Promise.resolve().then(() => refreshJokes(frozen)).finally(() => { jobs.delete(task); });
            jobs.add(task);
            return task;
        },
        stop(): Promise<void> | undefined {
            if (lifetime.signal.aborted) return drain;
            lifetime.abort();
            if (jobs.size) drain = Promise.allSettled([...jobs]).then(() => {});
            return drain;
        },
    };
}

/** 该不该抽、抽一次；返回是否真的调了模型 */
export async function refreshJokes(options: RefreshOptions): Promise<boolean> {
    const { qq, store, now, signal } = options;
    if (signal?.aborted) return false;
    const history = options.history.map(message => ({ ...message }));
    const sourceCurrent = () => {
        if (!options.freshHistory) return true;
        const current = options.freshHistory();
        return current.length >= history.length && history.every((message, index) => {
            const fresh = current[index]!;
            return fresh.role === message.role && fresh.time === message.time && fresh.content === message.content;
        });
    };
    const state = store.load(qq);
    const stateHash = digest(state);
    if (signal?.aborted) return false;
    if (Object.hasOwn(state, 'source') && (!validSource(state.source) || state.source.jokesHash !== jokesHash(state.jokes))) return false;
    const previousSourceMatches = sourceMatches(state, history);
    const recent = history.filter(message => message.time !== undefined && now - Date.parse(message.time) < JOKES_WINDOW_DAYS * DAY && Date.parse(message.time) <= now);
    if (recent.length < JOKES_MIN_MESSAGES) return false;
    if (state.updatedAt && now - Date.parse(state.updatedAt) < JOKES_REFRESH_MS) return false;
    const lastProcessed = state.messageCursor ? recent.findLastIndex(message => cursorOf(message) === state.messageCursor) : -1;
    const added = state.messageCursor ? recent.length - lastProcessed - 1 : state.updatedAt ? recent.filter(message => Date.parse(message.time!) > Date.parse(state.updatedAt!)).length : recent.length;
    if (previousSourceMatches && added < JOKES_MIN_NEW) return false;
    const transcript = recent.slice(-240).map(message => `${message.role === 'user' ? options.userName : options.charName}：${message.content.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
    const request: { role: 'user'; content: string }[] = [{ role: 'user', content: jokesPrompt(options.userName, options.charName, transcript) }];
    const requestHash = digest(request);
    let cancel: (() => void) | undefined;
    const cancelled = signal ? new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener('abort', cancel, { once: true }); }) : undefined;
    let reply: string | undefined;
    try {
        const pending = Promise.resolve().then(() => {
            if (signal?.aborted || !sourceCurrent() || signal?.aborted) return undefined;
            return options.extract(request.map(message => ({ ...message })));
        });
        reply = await (cancelled ? Promise.race([pending, cancelled]) : pending);
    } catch (error) { if (signal?.aborted) return false; throw error; }
    finally { if (cancel) signal?.removeEventListener('abort', cancel); }
    if (reply === undefined || signal?.aborted || !sourceCurrent() || signal?.aborted) return false;
    // 旧的还成立（在最近两周里仍然原样出现至少两次）的留着，新的接在后面，最多 JOKES_KEPT 个
    const stillThere = previousSourceMatches ? state.jokes.filter(joke => recent.filter(message => message.content.includes(joke.phrase)).length >= JOKE_MIN_OCCURRENCES) : [];
    const fresh = parseJokes(reply, recent).filter(joke => !stillThere.some(old => old.phrase === joke.phrase));
    const jokes = [...stillThere, ...fresh].slice(0, JOKES_KEPT);
    if (signal?.aborted) return false;
    // Another completed extraction may have published a newer snapshot while
    // this model was pending. Its confirmed progress must not be rolled back.
    if (digest(store.load(qq)) !== stateHash || signal?.aborted) return false;
    const source: JokeSource = { version: 1, count: history.length, historyHash: historyHash(history), requestHash, jokesHash: jokesHash(jokes) };
    store.save(qq, { version: 1, jokes, updatedAt: new Date(now).toISOString(), messageCount: recent.length, messageCursor: cursorOf(recent.at(-1)!), source });
    if (!signal?.aborted) options.log(`小梗：抽了一次，现在有 ${jokes.length} 个（新增 ${fresh.length}；日志不记内容）`);
    return true;
}

const hash = (text: string): number => {
    let h = 0x811c9dc5;
    for (const char of text) { h ^= char.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
};

/**
 * 这一轮要不要给她看一个梗：约 JOKE_TURN_SHARE 的轮次（按他最后一句和时间取哈希，同一句每次一样）；
 * 挑她 JOKE_COOLDOWN_MS 之内没说过的（她的话里原样出现过就算用过）；没有就 undefined
 */
export function jokeLine(jokes: readonly Joke[], history: readonly Said[], now: number): string | undefined {
    if (!jokes.length) return undefined;
    const lastUser = history.findLast(message => message.role === 'user');
    if (!lastUser || hash(`${lastUser.time ?? ''} ${lastUser.content} joke`) >= JOKE_TURN_SHARE) return undefined;
    const usedRecently = (joke: Joke) => history.some(message => message.role === 'assistant' && message.time !== undefined && now - Date.parse(message.time) < JOKE_COOLDOWN_MS && message.content.includes(joke.phrase));
    const pick = jokes.filter(joke => !usedRecently(joke))[Math.floor(hash(`${lastUser.time ?? ''} ${lastUser.content} which`) * Math.max(1, jokes.filter(joke => !usedRecently(joke)).length))];
    if (!pick) return undefined;
    return `[你们之间有个小梗「${pick.phrase}」（来历：${pick.origin}）：这一轮话赶话正好接得上，就顺口提一句；接不上就别提，别解释这个梗，也别每次都提]`;
}
