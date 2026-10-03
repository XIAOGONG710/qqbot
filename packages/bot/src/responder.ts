// 单个联系人的回复流程：收到消息先记入聊天记录，再生成回复、发送、记录。
// 回复按行拆成多条依次发出（像真人连发几条），每发出一条记一条；空行跳过。
// 消息调度（ADR 0004 决策 1，调研方案 5.2）：
// - 对方连发：等到对方停下 settle.quietMs 没有新消息再生成，但从这一串的第一条算起最多等 settle.maxMs，几条合在一起回复。
// - 生成期间又收到消息：这次生成没看到新消息，丢掉并带上新消息重新生成
//   （最多重来 MAX_REGENERATE 次，之后照常发出，避免对方一直在打字时永远回不了）。
// - 拆成几条发送的中途对方插话：剩下的几条已经过时，不再发；已经发出的照常记录，接着回复新消息。
// 同一时间只生成一条回复。（打字延迟、已读不回等拟人化行为在 M4。）

const MAX_REGENERATE = 2;
/** 拆开的几条之间隔多久 */
export const PART_GAP_MS = 1000;
/** 连发合并的默认值：静默约 2 秒，最长约 6 秒（调研方案 5.2 的起点） */
export const DEFAULT_SETTLE = { quietMs: 2000, maxMs: 6000 };

import type { ChatHistory } from './history.ts';
import type { ChatMessage, OpenAIMessage, PromptResult } from './prompt.ts';
import { splitReply } from './reply.ts';

export interface ResponderDeps {
    userId: number;
    history: Pick<ChatHistory, 'load' | 'append'>;
    buildPrompt: (history: ChatMessage[]) => PromptResult;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    clean: (reply: string) => string;
    send: (userId: number, text: string) => Promise<number>;
    log: (message: string) => void;
    sleep?: (ms: number) => Promise<void>;
    /** 毫秒时间戳，默认 Date.now（测试用假时钟） */
    now?: () => number;
    /** 连发合并；不传就不等，收到就回 */
    settle?: { quietMs: number; maxMs: number };
    /** 每次生成前把完整提示词交给调用方（main 写到 runtime/ 便于和 ST 对照） */
    onPrompt?: (prompt: PromptResult) => void;
}

export interface Responder {
    receive(text: string, messageId: number, time: Date): void;
    /** 不记新消息，直接按现有聊天记录回复一次（补回漏掉的消息之后用） */
    catchUp(): void;
    /** 当前没有在生成时 resolve（测试用） */
    whenIdle(): Promise<void>;
}

export function createResponder(deps: ResponderDeps): Responder {
    let running: Promise<void> | null = null;
    let pending = false;
    /** 聊天记录的前多少条已经被某次发出的回复“看到”过；之后还有对方的消息就要回复 */
    let seen = 0;
    /** 最近一次收到消息的时间；这一串连发里第一条的收到时间（开始生成时清掉） */
    let lastReceived: number | undefined;
    let burstStart: number | undefined;
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = deps.now ?? Date.now;

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
        for (let attempt = 0; ; attempt++) {
            await waitForQuiet();
            burstStart = undefined;
            const stored = deps.history.load(deps.userId);
            input = stored.length;
            if (!stored.slice(seen).some(m => m.role === 'user')) return;

            const prompt = deps.buildPrompt(stored.map(({ role, content, time }) => ({ role, content, time })));
            deps.onPrompt?.(prompt);
            const hits = prompt.activatedWorldInfo.map(e => e.comment || String(e.uid));
            deps.log(`生成回复：${prompt.messages.length} 条消息，命中世界书 ${hits.length ? hits.join('、') : '无'}`);

            reply = deps.clean(await deps.generate(prompt.messages));
            if (deps.history.load(deps.userId).length === stored.length || attempt >= MAX_REGENERATE) break;
            deps.log('生成期间收到新消息，带上新消息重新生成');
        }
        const parts = splitReply(reply);
        if (parts.length === 0) {
            deps.log('模型回复清理后为空，不发送');
            return;
        }
        const sent: string[] = [];
        for (const [i, part] of parts.entries()) {
            if (i > 0) {
                await sleep(PART_GAP_MS);
                if (deps.history.load(deps.userId).slice(input).some(m => m.role === 'user')) {
                    deps.log(`发送中途对方插话，剩下 ${parts.length - i} 条不发`);
                    break;
                }
            }
            const messageId = await deps.send(deps.userId, part);
            deps.history.append(deps.userId, { time: new Date().toISOString(), role: 'assistant', content: part, messageId });
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
            } catch (error) {
                deps.log(`回复失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    function schedule(): void {
        pending = true;
        running ??= loop().finally(() => { running = null; });
    }

    return {
        receive(text, messageId, time) {
            deps.history.append(deps.userId, { time: time.toISOString(), role: 'user', content: text, messageId });
            deps.log(`收到：${text}`);
            lastReceived = now();
            burstStart ??= lastReceived;
            schedule();
        },
        catchUp: schedule,
        whenIdle: () => running ?? Promise.resolve(),
    };
}
