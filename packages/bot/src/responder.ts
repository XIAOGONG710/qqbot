// 单个联系人的回复流程：收到消息先记入聊天记录，再生成回复、发送、记录。
// 回复按行拆成多条依次发出（像真人连发几条），每发出一条记一条；空行跳过。
// 同一时间只生成一条回复。生成期间又收到消息时，这次生成没看到新消息，丢掉并带上新消息重新生成
// （最多重来 MAX_REGENERATE 次，之后照常发出，避免对方一直在打字时永远回不了）。
// 发送期间收到的消息排在已发出的那几条后面，发完后再回复它们。
// （打字延迟、已读不回等拟人化行为在 M4。）

const MAX_REGENERATE = 2;
/** 拆开的几条之间隔多久 */
export const PART_GAP_MS = 1000;

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
    /** 每次生成前把完整提示词交给调用方（main 写到 runtime/ 便于和 ST 对照） */
    onPrompt?: (prompt: PromptResult) => void;
}

export interface Responder {
    receive(text: string, messageId: number, time: Date): void;
    /** 当前没有在生成时 resolve（测试用） */
    whenIdle(): Promise<void>;
}

export function createResponder(deps: ResponderDeps): Responder {
    let running: Promise<void> | null = null;
    let pending = false;
    /** 聊天记录的前多少条已经被某次发出的回复“看到”过；之后还有对方的消息就要回复 */
    let seen = 0;
    const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));

    async function respondOnce(): Promise<void> {
        let reply = '';
        let input = 0;
        for (let attempt = 0; ; attempt++) {
            const stored = deps.history.load(deps.userId);
            input = stored.length;
            if (!stored.slice(seen).some(m => m.role === 'user')) return;

            const prompt = deps.buildPrompt(stored.map(({ role, content }) => ({ role, content })));
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
        for (const [i, part] of parts.entries()) {
            if (i > 0) await sleep(PART_GAP_MS);
            const messageId = await deps.send(deps.userId, part);
            deps.history.append(deps.userId, { time: new Date().toISOString(), role: 'assistant', content: part, messageId });
        }
        seen = input;
        deps.log(`已回复${parts.length > 1 ? `（${parts.length} 条）` : ''}：${parts.join(' / ')}`);
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

    return {
        receive(text, messageId, time) {
            deps.history.append(deps.userId, { time: time.toISOString(), role: 'user', content: text, messageId });
            deps.log(`收到：${text}`);
            pending = true;
            running ??= loop().finally(() => { running = null; });
        },
        whenIdle: () => running ?? Promise.resolve(),
    };
}
