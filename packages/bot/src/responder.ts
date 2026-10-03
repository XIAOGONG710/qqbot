// 单个联系人的回复流程：收到消息先记入聊天记录，再生成回复、发送、记录。
// 同一时间只生成一条回复。生成期间又收到消息时，这次生成没看到新消息，丢掉并带上新消息重新生成
// （最多重来 MAX_REGENERATE 次，之后照常发出，避免对方一直在打字时永远回不了）。
// （按时间分条、延迟发送等拟人化行为在 M4。）

const MAX_REGENERATE = 2;

import type { ChatHistory } from './history.ts';
import type { ChatMessage, OpenAIMessage, PromptResult } from './prompt.ts';

export interface ResponderDeps {
    userId: number;
    history: Pick<ChatHistory, 'load' | 'append'>;
    buildPrompt: (history: ChatMessage[]) => PromptResult;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    clean: (reply: string) => string;
    send: (userId: number, text: string) => Promise<number>;
    log: (message: string) => void;
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

    async function respondOnce(): Promise<void> {
        let reply = '';
        for (let attempt = 0; ; attempt++) {
            const stored = deps.history.load(deps.userId);
            if (stored.at(-1)?.role !== 'user') return;

            const prompt = deps.buildPrompt(stored.map(({ role, content }) => ({ role, content })));
            deps.onPrompt?.(prompt);
            const hits = prompt.activatedWorldInfo.map(e => e.comment || String(e.uid));
            deps.log(`生成回复：${prompt.messages.length} 条消息，命中世界书 ${hits.length ? hits.join('、') : '无'}`);

            reply = deps.clean(await deps.generate(prompt.messages));
            if (deps.history.load(deps.userId).length === stored.length || attempt >= MAX_REGENERATE) break;
            deps.log('生成期间收到新消息，带上新消息重新生成');
        }
        if (!reply) {
            deps.log('模型回复清理后为空，不发送');
            return;
        }
        const messageId = await deps.send(deps.userId, reply);
        deps.history.append(deps.userId, { time: new Date().toISOString(), role: 'assistant', content: reply, messageId });
        deps.log(`已回复：${reply}`);
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
