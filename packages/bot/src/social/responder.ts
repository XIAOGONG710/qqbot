// 单个联系人的回复流程：收到消息先记入聊天记录，再生成回复、发送、记录。
// 回复按行拆成多条依次发出（像真人连发几条），超过 MAX_BUBBLES 行时合并成 MAX_BUBBLES 条（reply.ts）；每发出一条记一条，空行跳过。
// 消息调度（ADR 0004 决策 1，调研方案 5.2）：
// - 对方连发：等到对方停下 settle.quietMs 没有新消息再生成，但从这一串的第一条算起最多等 settle.maxMs，几条合在一起回复。
// - 生成期间又收到消息：这次生成没看到新消息，丢掉并带上新消息重新生成
//   （最多重来 MAX_REGENERATE 次，之后照常发出，避免对方一直在打字时永远回不了）。
// - 拆成几条发送的中途对方插话：剩下的几条已经过时，不再发；已经发出的照常记录，接着回复新消息。
// 同一时间只生成一条回复。
// 回复失败（多半是断网，llm.ts 里连接已经试了 5 次）：隔 retryAfterMs 再试，都失败就等对方下一条消息；
// 对方发了新消息就照常回复、重新计次。
// 回复时机（ADR 0007，传了 timing 才有）：先看她什么时候看到（上课、睡觉、冷场要等，等的时候来新消息就重算），
// 看到之后照上面等对方停下、生成；第一条最早在「看到 + 这条的打字时间」发出，之后每条隔这一条的打字时间；
// timing.skip 说不回的（她已经收尾、对方只回了附和；看心情不回，ADR 0013）不回，状态里留着最近一次的原因。
// stop()（Koishi 插件停用或因改配置重启，ADR 0008）：正在等的不再等，生成完的不发，排定的再试作废，之后收到的不处理；
// 没回的消息由新的回复器按聊天记录 catchUp（随机延迟按消息 id 取种子，「几点看到」不变）。
// initiate()（主动找他，ADR 0011）：和回复共用「同一时间只生成一条」；正在回、有没回的消息就不主动。
// 生成中他来了消息，草稿不发，照常回他；生成完、发之前先调 commit（先记后发，崩溃、断线后不重发）；试运行到 commit 为止。

const MAX_REGENERATE = 2;
/** 模型偶发只返回思考、正文为空；当场最多再生成两次，仍为空才进入分钟级延迟重试。 */
const MAX_EMPTY_REGENERATE = 2;
/** 拆开的几条之间隔多久 */
export const PART_GAP_MS = 1000;
/** 打字时对方那边显示「正在输入…」（ADR 0077）：不到这么久的等待不显示；QQ 的输入状态几秒就消，所以每隔这么久补发一次 */
export const TYPING_MIN_MS = 1500;
export const TYPING_REFRESH_MS = 4000;

/**
 * 打字打到一半停一下（ADR 0077 补，开着 typingStatus 才有）：他那边的「对方正在输入…」亮了一阵、灭掉几秒、又亮起来，真人打长句子常这样。
 * 只在要打 HESITATE_MIN_TYPING_MS 以上的长回复里、约 HESITATE_CHANCE 的轮次（按人和那一秒定，同一刻每次一样），在打了大约一半时停 HESITATE_PAUSE_MS 毫秒（QQ 的输入状态几秒自己消，停的时候不补发）
 */
export const HESITATE_CHANCE = 0.12;
export const HESITATE_MIN_TYPING_MS = 7000;
export const HESITATE_PAUSE_MS: [number, number] = [4500, 9000];
/** 连发合并的默认值：热聊里多等一下，把 3 秒内的第二句并进同一轮；最长不超过 12 秒（ADR 0019 决策 5）。 */
export const DEFAULT_SETTLE = { quietMs: 4000, maxMs: 12000 };
/** 回复失败之后的再试间隔：1 分钟、5 分钟各一次（10-04 与用户确认，不无限重试） */
export const RETRY_AFTER_MS = [60_000, 300_000];

import type { TypoRecall } from '../language/expression.ts';
import type { ChatHistory, StoredMessage } from '../memory/history.ts';
import { ModelUnreachable } from '../language/llm.ts';
import type { ChatMessage, OpenAIMessage, PromptResult } from '../language/prompt.ts';
import { PENDING_REASON } from '../proactive/proactive.ts';
import { pendingMessages, pick, type Seen } from './reply-timing.ts';
import { MAX_BUBBLES, splitReply } from '../language/reply.ts';

/** 拼好的提示词；note 是给日志的补充；maxBubbles 可让当前对话动作比作息上限更短。 */
export type BuiltPrompt = PromptResult & { note?: string; maxBubbles?: number };

/** 回复时机（reply-timing.ts 按作息算） */
export interface ReplyTiming {
    /** 没回的消息什么时候看到；没有没回的消息返回 undefined */
    whenSeen(history: StoredMessage[], now: number): Seen | undefined;
    /** 一条的打字时间 */
    typingMs(text: string): number;
    /** 看到消息之后、开始打字之前的「看 + 想」（只回他的消息时用；不传 = 没有） */
    thinkMs?(text: string): number;
    /** 这次不回的原因（收尾之后的附和）；要回就返回 undefined */
    skip(history: StoredMessage[]): string | undefined;
}

export interface ResponderDeps {
    userId: number;
    history: Pick<ChatHistory, 'load' | 'append'>;
    /**
     * 可以是异步的（生成前要先召回长期记忆）；woken：睡着时被消息吵醒（ADR 0007 决策 6）；
     * initiate：她主动找他（ADR 0011）：note 是这次为什么找（写进时间块之后），topic 是召回时想知道什么（ADR 0012）；
     * 返回的 note 接在「生成回复」那行日志后面
     */
    buildPrompt: (history: ChatMessage[], context: { woken?: boolean; initiate?: { note: string; topic: string; think?: boolean; photo?: 'cat' | 'food'; photoDish?: string }; offlineSince?: number }) => BuiltPrompt | Promise<BuiltPrompt>;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    clean: (reply: string) => string;
    /** 出口检查（ADR 0006）：清理之后、拆条之前，可能带说明重写一次；不传就不查 */
    review?: (reply: string, messages: OpenAIMessage[], context?: { allowRepeat?: boolean }) => Promise<string>;
    /**
     * 这一轮的回复定下来、马上要开始发送的那一刻（回复路径在拆条之后、主动路径在不是试运行之后）调一次。
     * 设备指令（ADR 0148）在这里登记并按档处理：回复被丢弃 / 重写时不会走到这里，所以丢弃的草稿不会操作他的设备
     */
    beforeSend?: () => void;
    /** 拆好条、发出去之前最后改一下（ADR 0024：打错字再改口）；maxBubbles 是这一轮最多几条；不传就原样发 */
    decorate?: (parts: string[], maxBubbles: number) => string[] | { parts: string[]; recall?: TypoRecall };
    /** replyTo：QQ 引用回复这一条（他的）消息（ADR 0136，配置 quoteReply）；只对文字有意义，不给就是普通的一条 */
    send: (userId: number, text: string, options?: { replyTo?: number }) => Promise<number>;
    /** 这一轮第一条要引用他的哪一条（ADR 0136）：发之前现取，没有就不引用；contact.ts 在拼提示词时定 */
    quote?: () => number | undefined;
    /** 打错字撤回失败、补「*对的词」时要不要引用刚才那条错的（ADR 0136，配置 quoteReply）；按那条错的消息 id 定 */
    quoteFix?: (wrongId: number) => boolean;
    /** 撤回自己发出去的一条（NapCat 的 delete_msg，配置 selfRecall，ADR 0086）；不传就不撤回，打错字照旧补一条「*对的词」 */
    recallOwn?: (messageId: number) => Promise<void>;
    /** 让对方那边显示「正在输入…」（ADR 0077）：她打字的这段时间里每隔几秒调一次，调用不等结果、出错也不影响发送；不传就不显示 */
    typing?: (userId: number) => void;
    /** 打字打到一半偶尔停几秒（默认会；false 不停，测试用）。只在显示「正在输入」时有意义 */
    hesitate?: boolean;
    /** 她「看到」他的消息的那一刻（ADR 0083，配置 readReceipts）：让他那边的消息从未读变成已读。不等结果、出错也不影响回复；不传就不标 */
    markRead?: () => void;
    /** 她看到了却决定不回（看心情不回、收尾后的附和）：给他最后一条消息点个表情回应（ADR 0083，配置 reactions）；不传就什么都不做 */
    react?: (messageId: number, text: string) => void;
    /** 实际发送内容与聊天记录表示不同时转换（图片表情编号 -> 可读描述）。 */
    historyContent?: (sent: string, messageId?: number) => string;
    log: (message: string) => void;
    /** 能不能把聊天正文写进日志（ADR 0070 第 8 项）；不传就不写，只记字数 */
    sensitive?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    /** 毫秒时间戳，默认 Date.now（测试用假时钟） */
    now?: () => number;
    /** 连发合并；不传就不等，收到就回 */
    settle?: { quietMs: number; maxMs: number };
    /** 每次生成前把完整提示词交给调用方（main 写到 runtime/ 便于和 ST 对照） */
    onPrompt?: (prompt: PromptResult) => void;
    /** 回复失败之后隔多久再试，每项一次；不传就不再试，等下一条消息 */
    retryAfterMs?: readonly number[];
    /** 回复时机；不传就收到就回、气泡之间隔 PART_GAP_MS */
    timing?: ReplyTiming;
    /** 等到某个时刻（看到消息之前的等待，可能几个小时）；signal 中止时马上返回。默认真实定时器，模拟器换成虚拟时钟上的 */
    waitUntil?: (at: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 回复器此刻在干什么（控制台「林梦瑶」页面的状态，ADR 0010）：
 * idle 空闲；waiting 等到 seenAt 才看到（reason 是原因：在睡觉、在上课……）；settling 对方还在连发；
 * generating 在生成；sending 在逐条发；retry 回复失败，retryAt 再试；initiating 在主动找他（生成或发送，reason 是时机）
 */
export interface ResponderStatus {
    phase: 'idle' | 'waiting' | 'settling' | 'generating' | 'sending' | 'retry' | 'initiating';
    seenAt?: number;
    reason?: string;
    retryAt?: number;
    /** 连着失败了几次 */
    failures: number;
    /** 最近一串没回（收尾后的附和、看心情）：什么时候、为什么；之后要回了就清掉 */
    skipped?: { at: number; reason: string };
}

/** 主动找他一次（ADR 0011） */
export interface InitiateRequest {
    /** 只取消这次主动请求，不停止普通回复。 */
    signal?: AbortSignal;
    /** 日志里的说法，例如「早安（起床后 12 分钟）」 */
    label: string;
    /** 提示词里的说明：这次是你主动找他、为什么 */
    note: string;
    /** 召回长期记忆时想知道什么（例如「他最近在忙什么、这几天的安排」） */
    topic: string;
    /** 最多几条气泡 */
    maxBubbles: number;
    /** 试运行：生成、出口检查、commit，然后写日志，不发、不进聊天记录 */
    dryRun: boolean;
    /** 生成完、发之前调用（先记后发）；抛错就不发 */
    commit: (parts: string[]) => void;
    /** 这句话本来就是固定的习惯说法，出口检查不按“最近说过一模一样的”去掉（B 站私信之后的提醒，ADR 0089） */
    allowRepeat?: boolean;
    /** 这一条要带一张照片（ADR 0110，喂完土豆拍的）：回复器让货架的这一类照片进提示词，并允许输出一行 <photo:编号> */
    photo?: 'cat' | 'food';
    /** 带的是吃的照片时，是哪道菜（ADR 0128）：货架里只拿这道菜的 */
    photoDish?: string;
    /** 她想了想可以决定先不发：模型只输出「不发」两个字就记成没发（催他回，ADR 0100） */
    canDecline?: boolean;
    /** 只想一想（ADR 0101，内心）：生成之后不清理、不检查、不发送、不 commit，把模型原文还给调用方；占用回复器的方式和主动找他一样（正在回消息、有没回的消息就不想） */
    think?: boolean;
}

class InitiateCancelled extends Error {
    constructor() { super('主动请求已取消'); }
}
function checkInitiate(signal?: AbortSignal): void { if (signal?.aborted) throw new InitiateCancelled(); }
function initiateWork<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work();
    if (signal.aborted) return Promise.reject(new InitiateCancelled());
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const cleanup = () => signal.removeEventListener('abort', cancel);
        const cancel = () => { if (!done) { done = true; cleanup(); reject(new InitiateCancelled()); } };
        signal.addEventListener('abort', cancel, { once: true });
        Promise.resolve().then(() => { checkInitiate(signal); return work(); }).then(value => {
            if (!done) { done = true; cleanup(); resolve(value); }
        }, error => { if (!done) { done = true; cleanup(); reject(error); } });
    });
}

export type InitiateOutcome =
    | { result: 'sent'; parts: string[]; messageIds: number[] }
    | { result: 'dryRun'; parts: string[] }
    /** think：模型原文（内心，ADR 0101） */
    | { result: 'thought'; text: string }
    /** 没发：正在回消息、有没回的消息、生成中他来了消息、生成的是空的、已停止 */
    | { result: 'skipped'; reason: string }
    /** 生成或发送出错（发送出错时可能已经发出了前几条）；unreachable：生成时没连上模型（断网、DNS、超时、429 / 5xx），计划器过一会儿再试 */
    | { result: 'failed'; reason: string; messageIds?: number[]; unreachable?: true };

export interface Responder {
    receive(text: string, messageId: number, time: Date, messageSeq?: string): void;
    /** 此刻在干什么（只读） */
    status(): ResponderStatus;
    /** 不记新消息，直接按现有聊天记录回复一次（补回漏掉的消息之后用） */
    catchUp(): void;
    /** 主动找他一次（见文件开头） */
    initiate(request: InitiateRequest): Promise<InitiateOutcome>;
    /** 当前没有在生成时 resolve（测试用） */
    whenIdle(): Promise<void>;
    /** 没在生成，或者正等着到点看到消息时 resolve（模拟器用：这时可以把虚拟时钟往前拨） */
    whenQuiet(): Promise<void>;
    /** 停下，之后不再生成、不再发送（见文件开头） */
    stop(): void;
}

/** 默认的等待：真实定时器 */
function waitUntilReal(at: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, Math.max(0, at - Date.now()));
        signal.addEventListener('abort', done);
        if (signal.aborted) done();
    });
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

export function createResponder(deps: ResponderDeps): Responder {
    let running: Promise<void> | null = null;
    let pending = false;
    /** 聊天记录的前多少条已经被某次发出的回复“看到”过；之后还有对方的消息就要回复 */
    let seen = 0;
    /** 最近一次收到消息的时间；这一串连发里第一条的收到时间（开始生成时清掉） */
    let lastReceived: number | undefined;
    let burstStart: number | undefined;
    /** 连着失败了几次；有新消息或者成功一次就清零 */
    let failures = 0;
    /** 每排定一次再试加一；等待期间来了新消息也加一，等到的那次就不再触发 */
    let retryToken = 0;
    const retryAfter = deps.retryAfterMs ?? [];
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    /**
     * 打字的这段时间：对方那边显示「正在输入…」（ADR 0077）。QQ 的输入状态几秒就消，所以每 TYPING_REFRESH_MS 补发一次；
     * 太短的（不到 TYPING_MIN_MS）不显示，真人也不会有「刚显示就收到」的闪一下；发出那条消息，状态自己消失
     */
    /**
     * 发一条。recall 有值（打错字又想改口，ADR 0086）：先发打错的那条，过 afterMs 撤回，再「打字」发对的那条；聊天记录里只有对的。
     * 撤回失败（超过两分钟、NapCat 报错）：错的留着，补发「*对的词」，和不撤回时一样，两条都进聊天记录
     */
    async function sendBubble(part: string, recall: TypoRecall | undefined, replyTo?: number, signal?: AbortSignal): Promise<{ messageId: number; content: string } | undefined> {
        if (signal?.aborted) return undefined;
        const quoted = replyTo === undefined ? undefined : { replyTo };
        if (!recall) return { messageId: await deps.send(deps.userId, part, quoted), content: part };
        const wrongId = await deps.send(deps.userId, recall.wrong, quoted);
        if (signal?.aborted) return { messageId: wrongId, content: recall.wrong };
        try { await initiateWork(() => sleep(recall.afterMs), signal); }
        catch (error) { if (error instanceof InitiateCancelled) return { messageId: wrongId, content: recall.wrong }; throw error; }
        if (signal?.aborted) return { messageId: wrongId, content: recall.wrong };
        try {
            await deps.recallOwn!(wrongId);
        } catch (error) {
            if (signal?.aborted) return { messageId: wrongId, content: recall.wrong };
            deps.log(`撤回自己打错的那条失败，补一条改口：${error instanceof Error ? error.message : String(error)}`);
            deps.history.append(deps.userId, {
                time: new Date(now()).toISOString(), role: 'assistant',
                content: deps.historyContent?.(recall.wrong, wrongId) ?? recall.wrong, messageId: wrongId,
            });
            // 补「*对的词」：有时引用刚才那条错的（ADR 0136）
            const fixQuote = deps.quoteFix?.(wrongId) ? { replyTo: wrongId } : undefined;
            if (signal?.aborted) return undefined;
            return { messageId: await deps.send(deps.userId, recall.fix, fixQuote), content: recall.fix };
        }
        if (signal?.aborted) return undefined;
        deps.log('打错字，撤回重发');
        try { await (deps.timing ? sleepTyping(deps.timing.typingMs(part), signal) : initiateWork(() => sleep(PART_GAP_MS), signal)); }
        catch (error) { if (error instanceof InitiateCancelled) return undefined; throw error; }
        if (signal?.aborted) return undefined;
        return { messageId: await deps.send(deps.userId, part, quoted), content: part };
    }

    async function sleepTyping(ms: number, signal?: AbortSignal): Promise<void> {
        checkInitiate(signal);
        if (!deps.typing || ms < TYPING_MIN_MS) return initiateWork(() => sleep(ms), signal);
        const seed = `${deps.userId} ${Math.floor(now() / 1000)}`;
        if (deps.hesitate !== false && ms >= HESITATE_MIN_TYPING_MS && pick(seed, 'hesitate', [0, 999]) < HESITATE_CHANCE * 1000) {
            const before = Math.round(ms * 0.45);
            await typeFor(before, signal);
            checkInitiate(signal);
            if (stopped) return;
            const pause = pick(seed, 'hesitate-pause', HESITATE_PAUSE_MS);
            deps.log(`打字打到一半停了 ${Math.round(pause / 1000)} 秒`);
            await initiateWork(() => sleep(pause), signal);
            return typeFor(ms - before, signal);
        }
        return typeFor(ms, signal);
    }
    async function typeFor(ms: number, signal?: AbortSignal): Promise<void> {
        const end = now() + ms;
        for (;;) {
            checkInitiate(signal);
            try { deps.typing!(deps.userId); } catch { /* 显示不出来不影响发送 */ }
            const left = end - now();
            if (left <= TYPING_REFRESH_MS || stopped) return initiateWork(() => sleep(Math.max(0, left)), signal);
            await initiateWork(() => sleep(TYPING_REFRESH_MS), signal);
        }
    }
    const now = deps.now ?? Date.now;
    const waitUntil = deps.waitUntil ?? waitUntilReal;
    /** 正等着到点看到消息：中止它（来了新消息，重算什么时候看到） */
    let interruptWait: (() => void) | undefined;
    /** whenQuiet() 在等的 */
    const quietWaiters: (() => void)[] = [];
    /** 上次日志里写的「几点看到」，没变就不重复写 */
    let loggedSeenAt: number | undefined;
    let stopped = false;
    let phase: Omit<ResponderStatus, 'failures' | 'skipped'> = { phase: 'idle' };
    const setPhase = (next: Omit<ResponderStatus, 'failures' | 'skipped'>) => { phase = next; };
    let skipped: ResponderStatus['skipped'];
    /** 回复从这一刻起一直失败（连不上模型 / 网断了），发出去之后清掉（ADR 0105：断网很久才回，时间块里写一句） */
    let failingSince: number | undefined;

    /** 等到 at，期间来新消息就提前返回 */
    async function waitForSeen(at: number): Promise<void> {
        const controller = new AbortController();
        interruptWait = () => controller.abort();
        for (const resolve of quietWaiters.splice(0)) resolve();
        try {
            await waitUntil(at, controller.signal);
        } finally {
            interruptWait = undefined;
        }
    }

    /**
     * 她什么时候看到没回的消息（timing）：到点之前一直等，等的时候来了新消息就重算。
     * 返回看到时的判断；没有要回的（没有没回的消息、收尾之后的附和）返回 null
     */
    async function untilSeen(timing: ReplyTiming): Promise<Seen | null> {
        for (;;) {
            const stored = deps.history.load(deps.userId);
            if (!stored.slice(seen).some(m => m.role === 'user')) return null;
            const skip = timing.skip(stored);
            if (skip) {
                deps.log(skip);
                // 看到了不回：已读不回，再点个表情回应（最后一条是真消息才点；戳一戳那种合成的 id 不点）
                deps.markRead?.();
                const last = stored.slice(seen).findLast(m => m.role === 'user');
                if (deps.react && last?.messageId !== undefined && last.messageId < 2 ** 32) deps.react(last.messageId, last.content);
                skipped = { at: now(), reason: skip };
                seen = stored.length;
                return null;
            }
            skipped = undefined;
            const decision = timing.whenSeen(stored, now());
            if (!decision) return null;
            if (decision.at <= now()) {
                deps.markRead?.();
                return decision;
            }
            if (decision.at !== loggedSeenAt) deps.log(`${decision.reason}，${clock(decision.at)} 看到`);
            loggedSeenAt = decision.at;
            setPhase({ phase: 'waiting', seenAt: decision.at, reason: decision.reason });
            await waitForSeen(decision.at);
            if (stopped) return null;
        }
    }

    /** 对方还在连发就等：静默够久，或者这一串已经等到上限 */
    async function waitForQuiet(): Promise<void> {
        if (!deps.settle || lastReceived === undefined || burstStart === undefined) return;
        const { quietMs, maxMs } = deps.settle;
        for (;;) {
            const t = now();
            const quiet = t - lastReceived;
            const waited = t - burstStart;
            if (quiet >= quietMs || waited >= maxMs) return;
            await sleep(Math.min(quietMs - quiet, maxMs - waited));
        }
    }

    async function respondOnce(): Promise<void> {
        let reply = '';
        let input = 0;
        let decision: Seen | undefined;
        let promptMaxBubbles: number | undefined;
        let seenAt = 0;
        let emptyRetries = 0;
        for (let attempt = 0; ; attempt++) {
            // 看到之前（重新生成时她已经在看手机了，不再等）
            if (deps.timing && attempt === 0) {
                const result = await untilSeen(deps.timing);
                if (!result) return;
                decision = result;
                if (decision.woken) deps.log(decision.reason);
            }
            setPhase({ phase: 'settling' });
            await waitForQuiet();
            if (stopped) return;
            burstStart = undefined;
            const stored = deps.history.load(deps.userId);
            input = stored.length;
            if (!stored.slice(seen).some(m => m.role === 'user')) return;
            seenAt = now();
            setPhase({ phase: 'generating' });

            const prompt = await deps.buildPrompt(stored.map(({ role, content, time }) => ({ role, content, time })), { woken: decision?.woken, ...(failingSince !== undefined ? { offlineSince: failingSince } : {}) });
            promptMaxBubbles = prompt.maxBubbles;
            deps.onPrompt?.(prompt);
            const hits = prompt.activatedWorldInfo.map(e => e.comment || String(e.uid));
            deps.log(`生成回复：${prompt.messages.length} 条消息，命中世界书 ${hits.length ? hits.join('、') : '无'}${prompt.note ? `，${prompt.note}` : ''}`);

            reply = prompt.fallbackReply ?? deps.clean(await deps.generate(prompt.messages));
            if (deps.review && !prompt.fallbackReply) reply = await deps.review(reply, prompt.messages);
            if (stopped) {
                deps.log('已停止，这次生成的回复不发');
                return;
            }
            // 模型偶尔返回空串；真实 API 复测里出现过连续两次空正文，最多当场再生成两次。
            if (splitReply(reply).length === 0 && emptyRetries < MAX_EMPTY_REGENERATE) {
                emptyRetries++;
                deps.log('模型回复清理后为空，重新生成一次');
                continue;
            }
            if (deps.history.load(deps.userId).length === stored.length || attempt >= MAX_REGENERATE) break;
            deps.log('生成期间收到新消息，带上新消息重新生成');
        }
        const maxBubbles = Math.min(decision?.maxBubbles ?? MAX_BUBBLES, promptMaxBubbles ?? MAX_BUBBLES);
        const split = splitReply(reply, maxBubbles);
        // 再生成还是空：算回复失败，按 retryAfterMs 过一会儿再试
        if (split.length === 0) throw new Error('模型回复清理后为空');
        const decorated = deps.decorate ? deps.decorate(split, maxBubbles) : split;
        const parts = Array.isArray(decorated) ? decorated : decorated.parts;
        const recall = Array.isArray(decorated) || !deps.recallOwn ? undefined : decorated.recall;
        deps.beforeSend?.();
        setPhase({ phase: 'sending' });
        const { timing } = deps;
        // 第一条：生成花掉的时间算在打字时间里
        if (timing) {
            const thinkEnd = seenAt + (timing.thinkMs?.(parts[0]!) ?? 0);
            // 「想」的那段（ADR 0075）她还没开始打字，不显示「正在输入」；打字的那段才显示（ADR 0077）
            if (deps.typing && thinkEnd > now()) await sleep(thinkEnd - now());
            const due = thinkEnd + timing.typingMs(parts[0]!) - now();
            if (due > 0) await sleepTyping(due);
        }
        const sent: string[] = [];
        // 这一轮第一条引用他的某一句（ADR 0136）：只引一次，只在第一条
        const quoteId = deps.quote?.();
        for (const [i, part] of parts.entries()) {
            if (i > 0) {
                await (timing ? sleepTyping(timing.typingMs(part)) : sleep(PART_GAP_MS));
                if (deps.history.load(deps.userId).slice(input).some(m => m.role === 'user')) {
                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);
                    break;
                }
            }
            if (stopped) {
                deps.log(`已停止，剩下 ${parts.length - i} 条不发`);
                break;
            }
            const bubble = await sendBubble(part, recall?.index === i ? recall : undefined, i === 0 ? quoteId : undefined);
            if (!bubble) break;
            const { messageId, content } = bubble;
            deps.history.append(deps.userId, {
                time: new Date(now()).toISOString(), role: 'assistant',
                content: deps.historyContent?.(content, messageId) ?? content, messageId,
            });
            sent.push(content);
        }
        seen = input;
        failingSince = undefined;
        deps.log(`已回复${sent.length > 1 ? `（${sent.length} 条）` : ''}：${deps.sensitive?.() ? sent.join(' / ') : `${sent.reduce((total, part) => total + [...part].length, 0)} 字`}`);
    }

    async function loop(): Promise<void> {
        while (pending && !stopped) {
            pending = false;
            setPhase({ phase: 'idle' });
            try {
                await respondOnce();
                failures = 0;
            } catch (error) {
                const reason = `回复失败：${error instanceof Error ? error.message : String(error)}`;
                failingSince ??= now();
                if (stopped) {
                    deps.log(`${reason}（已停止，不再试）`);
                    continue;
                }
                const delay = retryAfter[failures];
                if (delay === undefined) {
                    deps.log(retryAfter.length ? `${reason}，等对方下一条消息再回` : reason);
                    continue;
                }
                failures++;
                deps.log(`${reason}，${delay / 60_000} 分钟后再试`);
                const token = ++retryToken;
                setPhase({ phase: 'retry', retryAt: now() + delay, reason });
                void sleep(delay).then(() => { if (token === retryToken) schedule(); });
            }
        }
        if (phase.phase !== 'retry' || stopped) setPhase({ phase: 'idle' });
    }

    /** 主动计划和发送共用事实时界；普通回复路径保持自己的接收/补回政策。 */
    function initiateHistory(history: StoredMessage[]): StoredMessage[] {
        const current = now();
        return history.filter(message => {
            const time = Date.parse(message.time);
            return Number.isFinite(time) && time <= current;
        });
    }

    /** 主动找他一次（initiate 已确认此刻空闲、没有要回的消息） */
    async function initiateOnce(request: InitiateRequest): Promise<InitiateOutcome> {
        checkInitiate(request.signal);
        const stored = deps.history.load(deps.userId);
        const input = stored.length;
        const startedAt = now();
        setPhase({ phase: 'initiating', reason: request.label });
        const prompt = await initiateWork(async () => deps.buildPrompt(initiateHistory(stored).map(({ role, content, time }) => ({ role, content, time })), { initiate: { note: request.note, topic: request.topic, ...(request.think ? { think: true } : {}), ...(request.photo ? { photo: request.photo } : {}), ...(request.photoDish ? { photoDish: request.photoDish } : {}) } }), request.signal);
        checkInitiate(request.signal);
        if (prompt.fallbackReply) return { result: 'skipped', reason: '提示词超出预算' };
        deps.onPrompt?.(prompt);
        const hits = prompt.activatedWorldInfo.map(e => e.comment || String(e.uid));
        deps.log(`主动找他（${request.label}）：生成，${prompt.messages.length} 条消息，命中世界书 ${hits.length ? hits.join('、') : '无'}`);
        const raw = await initiateWork(() => deps.generate(prompt.messages), request.signal);
        checkInitiate(request.signal);
        if (request.think) return { result: 'thought', text: raw };
        // 她想了想决定先不发（ADR 0100）：只有「不发」两个字，带不带括号都算
        if (request.canDecline && /^\s*[（(【[]?\s*不发\s*[）)】\]]?[。.！!]?\s*$/.test(raw)) return { result: 'skipped', reason: '她想了想，先不发' };
        let reply = deps.clean(raw);
        if (deps.review) reply = await initiateWork(() => deps.review!(reply, prompt.messages, request.allowRepeat ? { allowRepeat: true } : undefined), request.signal);
        checkInitiate(request.signal);
        if (stopped) return { result: 'skipped', reason: '已停止' };
        if (initiateHistory(deps.history.load(deps.userId).slice(input)).some(m => m.role === 'user')) {
            return { result: 'skipped', reason: '生成期间他来了消息，草稿不发，照常回他' };
        }
        // 空的不再生成（宁可少发）
        const split = splitReply(reply, request.maxBubbles);
        if (split.length === 0) return { result: 'skipped', reason: '生成的是空的' };
        const decorated = deps.decorate ? deps.decorate(split, request.maxBubbles) : split;
        const parts = Array.isArray(decorated) ? decorated : decorated.parts;
        const recall = Array.isArray(decorated) || !deps.recallOwn ? undefined : decorated.recall;
        checkInitiate(request.signal);
        request.commit(parts);
        checkInitiate(request.signal);
        if (request.dryRun) return { result: 'dryRun', parts };
        deps.beforeSend?.();

        const { timing } = deps;
        if (timing) {
            const due = startedAt + timing.typingMs(parts[0]!) - now();
            if (due > 0) await sleepTyping(due, request.signal);
        }
        const messageIds: number[] = [];
        const sent: string[] = [];
        for (const [i, part] of parts.entries()) {
            if (request.signal?.aborted) break;
            if (i > 0) {
                try { await (timing ? sleepTyping(timing.typingMs(part), request.signal) : initiateWork(() => sleep(PART_GAP_MS), request.signal)); }
                catch (error) { if (error instanceof InitiateCancelled) break; throw error; }
                if (initiateHistory(deps.history.load(deps.userId).slice(input)).some(m => m.role === 'user')) {
                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);
                    break;
                }
            }
            if (stopped || request.signal?.aborted) {
                deps.log(`已停止，剩下 ${parts.length - i} 条不发`);
                break;
            }
            let bubble: { messageId: number; content: string };
            try {
                const confirmed = await sendBubble(part, recall?.index === i ? recall : undefined, undefined, request.signal);
                if (!confirmed) break;
                bubble = confirmed;
            } catch (error) {
                return { result: 'failed', reason: `发送失败：${error instanceof Error ? error.message : String(error)}`, ...(messageIds.length ? { messageIds } : {}) };
            }
            deps.history.append(deps.userId, {
                time: new Date(now()).toISOString(), role: 'assistant',
                content: deps.historyContent?.(bubble.content, bubble.messageId) ?? bubble.content, messageId: bubble.messageId,
            });
            messageIds.push(bubble.messageId);
            sent.push(bubble.content);
        }
        if (sent.length) skipped = undefined;
        return sent.length ? { result: 'sent', parts: sent, messageIds } : { result: 'skipped', reason: '已停止' };
    }

    /** 新消息或补回：之前排定的再试作废，重新计次 */
    function restart(): void {
        retryToken++;
        failures = 0;
        schedule();
    }

    function schedule(): void {
        if (stopped) return;
        pending = true;
        running ??= loop().finally(() => {
            running = null;
            for (const resolve of quietWaiters.splice(0)) resolve();
        });
    }

    return {
        receive(text, messageId, time, messageSeq) {
            if (stopped) return;
            deps.history.append(deps.userId, { time: time.toISOString(), role: 'user', content: text, messageId, ...(messageSeq ? { messageSeq } : {}) });
            deps.log(`收到：${deps.sensitive?.() ? text : `${[...text].length} 字`}`);
            lastReceived = now();
            burstStart ??= lastReceived;
            restart();
            interruptWait?.();
        },
        catchUp() {
            restart();
            interruptWait?.();
        },
        initiate(request) {
            const skip = (reason: string) => Promise.resolve<InitiateOutcome>({ result: 'skipped', reason });
            if (stopped) return skip('已停止');
            if (request.signal?.aborted) return skip('主动请求已取消');
            if (running) return skip('正在回消息');
            // 按「不回」处理过的（看心情没回的「哈哈」）不挡主动消息
            const stored = initiateHistory(deps.history.load(deps.userId));
            if (pendingMessages(stored).length && !deps.timing?.skip(stored)) return skip(PENDING_REASON);
            const task = initiateOnce(request).catch((error): InitiateOutcome => error instanceof InitiateCancelled ? { result: 'skipped', reason: '主动请求已取消' } : ({
                result: 'failed', reason: `生成失败：${error instanceof Error ? error.message : String(error)}`,
                ...(error instanceof ModelUnreachable ? { unreachable: true as const } : {}),
            }));
            running = task.then(() => {
                running = null;
                if (phase.phase === 'initiating') setPhase({ phase: 'idle' });
                for (const resolve of quietWaiters.splice(0)) resolve();
                // 主动的时候他来了消息：现在照常回
                if (pending) schedule();
            });
            return task;
        },
        status: () => ({ ...phase, failures, ...(skipped ? { skipped } : {}) }),
        whenIdle: () => running ?? Promise.resolve(),
        whenQuiet: () => (running && !interruptWait ? new Promise<void>(resolve => { quietWaiters.push(resolve); }) : Promise.resolve()),
        stop() {
            stopped = true;
            pending = false;
            retryToken++;
            setPhase({ phase: 'idle' });
            interruptWait?.();
        },
    };
}
