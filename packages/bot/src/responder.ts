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
// 她已经收尾、对方只回了附和的，不回。

const MAX_REGENERATE = 2;
/** 拆开的几条之间隔多久 */
export const PART_GAP_MS = 1000;
/** 连发合并的默认值：静默约 2 秒，最长约 6 秒（调研方案 5.2 的起点） */
export const DEFAULT_SETTLE = { quietMs: 2000, maxMs: 6000 };
/** 回复失败之后的再试间隔：1 分钟、5 分钟各一次（10-04 与用户确认，不无限重试） */
export const RETRY_AFTER_MS = [60_000, 300_000];

import type { ChatHistory, StoredMessage } from './history.ts';
import type { ChatMessage, OpenAIMessage, PromptResult } from './prompt.ts';
import type { Seen } from './reply-timing.ts';
import { MAX_BUBBLES, splitReply } from './reply.ts';

/** 回复时机（reply-timing.ts 按作息算） */
export interface ReplyTiming {
    /** 没回的消息什么时候看到；没有没回的消息返回 undefined */
    whenSeen(history: StoredMessage[], now: number): Seen | undefined;
    /** 一条的打字时间 */
    typingMs(text: string): number;
    /** 这次不回的原因（收尾之后的附和）；要回就返回 undefined */
    skip(history: StoredMessage[]): string | undefined;
}

export interface ResponderDeps {
    userId: number;
    history: Pick<ChatHistory, 'load' | 'append'>;
    /** 可以是异步的（生成前要先召回长期记忆）；woken：睡着时被消息吵醒（ADR 0007 决策 6） */
    buildPrompt: (history: ChatMessage[], context: { woken?: boolean }) => PromptResult | Promise<PromptResult>;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    clean: (reply: string) => string;
    /** 出口检查（ADR 0006）：清理之后、拆条之前，可能带说明重写一次；不传就不查 */
    review?: (reply: string, messages: OpenAIMessage[]) => Promise<string>;
    send: (userId: number, text: string) => Promise<number>;
    log: (message: string) => void;
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

export interface Responder {
    receive(text: string, messageId: number, time: Date): void;
    /** 不记新消息，直接按现有聊天记录回复一次（补回漏掉的消息之后用） */
    catchUp(): void;
    /** 当前没有在生成时 resolve（测试用） */
    whenIdle(): Promise<void>;
    /** 没在生成，或者正等着到点看到消息时 resolve（模拟器用：这时可以把虚拟时钟往前拨） */
    whenQuiet(): Promise<void>;
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
    const now = deps.now ?? Date.now;
    const waitUntil = deps.waitUntil ?? waitUntilReal;
    /** 正等着到点看到消息：中止它（来了新消息，重算什么时候看到） */
    let interruptWait: (() => void) | undefined;
    /** whenQuiet() 在等的 */
    const quietWaiters: (() => void)[] = [];
    /** 上次日志里写的「几点看到」，没变就不重复写 */
    let loggedSeenAt: number | undefined;

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
                seen = stored.length;
                return null;
            }
            const decision = timing.whenSeen(stored, now());
            if (!decision) return null;
            if (decision.at <= now()) return decision;
            if (decision.at !== loggedSeenAt) deps.log(`${decision.reason}，${clock(decision.at)} 看到`);
            loggedSeenAt = decision.at;
            await waitForSeen(decision.at);
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
        let seenAt = 0;
        let retriedEmpty = false;
        for (let attempt = 0; ; attempt++) {
            // 看到之前（重新生成时她已经在看手机了，不再等）
            if (deps.timing && attempt === 0) {
                const result = await untilSeen(deps.timing);
                if (!result) return;
                decision = result;
                if (decision.woken) deps.log(decision.reason);
            }
            await waitForQuiet();
            burstStart = undefined;
            const stored = deps.history.load(deps.userId);
            input = stored.length;
            if (!stored.slice(seen).some(m => m.role === 'user')) return;
            seenAt = now();

            const prompt = await deps.buildPrompt(stored.map(({ role, content, time }) => ({ role, content, time })), { woken: decision?.woken });
            deps.onPrompt?.(prompt);
            const hits = prompt.activatedWorldInfo.map(e => e.comment || String(e.uid));
            deps.log(`生成回复：${prompt.messages.length} 条消息，命中世界书 ${hits.length ? hits.join('、') : '无'}`);

            reply = deps.clean(await deps.generate(prompt.messages));
            if (deps.review) reply = await deps.review(reply, prompt.messages);
            // 模型偶尔返回空串（10-05 模拟器 817 次生成里 2 次，原样重发 4 次都有正文）：当场再生成一次
            if (splitReply(reply).length === 0 && !retriedEmpty) {
                retriedEmpty = true;
                deps.log('模型回复清理后为空，重新生成一次');
                continue;
            }
            if (deps.history.load(deps.userId).length === stored.length || attempt >= MAX_REGENERATE) break;
            deps.log('生成期间收到新消息，带上新消息重新生成');
        }
        const parts = splitReply(reply, decision?.maxBubbles ?? MAX_BUBBLES);
        // 再生成还是空：算回复失败，按 retryAfterMs 过一会儿再试
        if (parts.length === 0) throw new Error('模型回复清理后为空');
        const { timing } = deps;
        // 第一条：生成花掉的时间算在打字时间里
        if (timing) {
            const due = seenAt + timing.typingMs(parts[0]!) - now();
            if (due > 0) await sleep(due);
        }
        const sent: string[] = [];
        for (const [i, part] of parts.entries()) {
            if (i > 0) {
                await sleep(timing ? timing.typingMs(part) : PART_GAP_MS);
                if (deps.history.load(deps.userId).slice(input).some(m => m.role === 'user')) {
                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);
                    break;
                }
            }
            const messageId = await deps.send(deps.userId, part);
            deps.history.append(deps.userId, { time: new Date(now()).toISOString(), role: 'assistant', content: part, messageId });
            sent.push(part);
        }
        seen = input;
        deps.log(`已回复${sent.length > 1 ? `（${sent.length} 条）` : ''}：${sent.join(' / ')}`);
    }

    async function loop(): Promise<void> {
        while (pending) {
            pending = false;
            try {
                await respondOnce();
                failures = 0;
            } catch (error) {
                const reason = `回复失败：${error instanceof Error ? error.message : String(error)}`;
                const delay = retryAfter[failures];
                if (delay === undefined) {
                    deps.log(retryAfter.length ? `${reason}，等对方下一条消息再回` : reason);
                    continue;
                }
                failures++;
                deps.log(`${reason}，${delay / 60_000} 分钟后再试`);
                const token = ++retryToken;
                void sleep(delay).then(() => { if (token === retryToken) schedule(); });
            }
        }
    }

    /** 新消息或补回：之前排定的再试作废，重新计次 */
    function restart(): void {
        retryToken++;
        failures = 0;
        schedule();
    }

    function schedule(): void {
        pending = true;
        running ??= loop().finally(() => {
            running = null;
            for (const resolve of quietWaiters.splice(0)) resolve();
        });
    }

    return {
        receive(text, messageId, time) {
            deps.history.append(deps.userId, { time: time.toISOString(), role: 'user', content: text, messageId });
            deps.log(`收到：${text}`);
            lastReceived = now();
            burstStart ??= lastReceived;
            restart();
            interruptWait?.();
        },
        catchUp() {
            restart();
            interruptWait?.();
        },
        whenIdle: () => running ?? Promise.resolve(),
        whenQuiet: () => (running && !interruptWait ? new Promise<void>(resolve => { quietWaiters.push(resolve); }) : Promise.resolve()),
    };
}
