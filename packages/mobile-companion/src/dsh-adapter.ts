import type { ActionResult, CompanionMessage, MediaRef, PhoneActionRequest } from './protocol.ts';
import type { CompanionRuntimeHandlers } from './runtime.ts';

export interface DshConversationTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface DshCompanionRequest<TState = unknown, TVoice = unknown> {
    question: string;
    state?: TState;
    recentTurns?: readonly DshConversationTurn[];
    voice?: TVoice;
    /** 可选的媒体摘要；原始字节不会自动进入 DSH。 */
    media?: MediaRef;
}

export interface DshCompanionAdvisor<TState = unknown, TVoice = unknown> {
    advise(request: DshCompanionRequest<TState, TVoice>): Promise<string>;
}

export interface DshSharedConversation {
    /** 返回 QQ、DSH 桌面和其他已授权伴侣端共用的最近上下文。 */
    recent(clientId: string): readonly DshConversationTurn[] | undefined;
    /** 只在本轮完整成功且配对仍有效时提交，失败请求不能留下半截上下文。 */
    commit(clientId: string, question: string, reply: string, askedAt: number, repliedAt: number): void;
}

export interface DshCompanionAdapterOptions<TState = unknown, TVoice = unknown> {
    advisor: DshCompanionAdvisor<TState, TVoice>;
    state?: (clientId: string) => TState | undefined;
    voice?: (clientId: string) => TVoice | undefined;
    /** 宿主可接入 STT / OCR / vision；返回的摘要会作为本轮问题，不返回则保持兼容的占位文本。 */
    describeMedia?: (message: CompanionMessage, clientId: string) => Promise<string | undefined>;
    maxTurns?: number;
    /** 最多保留多少台设备的短期上下文，避免大量临时 clientId 造成内存增长。 */
    maxClients?: number;
    /** 宿主提供时，伴侣端不再维护孤立上下文，而是接入同一个她的跨端短期上下文。 */
    sharedConversation?: DshSharedConversation;
    now?: () => number;
    onAction?: (request: PhoneActionRequest, clientId: string, requestId: string) => Promise<ActionResult>;
}

/** 把手机文字消息接回 DSH；动作不绕过宿主的设备策略。 */
export function createDshCompanionHandlers<TState = unknown, TVoice = unknown>(options: DshCompanionAdapterOptions<TState, TVoice>): CompanionRuntimeHandlers {
    const maxTurns = options.maxTurns ?? 12;
    if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 40) throw new Error('DSH 伴侣上下文长度不合法');
    const maxClients = options.maxClients ?? 64;
    if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 1024) throw new Error('DSH 伴侣设备上下文上限不合法');
    const conversations = new Map<string, DshConversationTurn[]>();
    const now = options.now ?? Date.now;
    let resetGeneration = 0;

    return {
        async onMessage(message: CompanionMessage, clientId: string): Promise<CompanionMessage> {
            const generation = resetGeneration;
            const askedAt = now();
            const turns = conversations.get(clientId) ?? [];
            const described = !message.text?.trim() && options.describeMedia ? await options.describeMedia(message, clientId) : undefined;
            const question = message.text?.trim() || described?.trim().slice(0, 4000) || `[收到${message.kind}消息]`;
            const recentTurns = (options.sharedConversation?.recent(clientId) ?? turns).slice(-Math.min(6, maxTurns));
            if (!options.sharedConversation) turns.push({ role: 'user', content: question });
            const reply = (await options.advisor.advise({
                question,
                ...(options.state ? { state: options.state(clientId) } : {}),
                ...(recentTurns.length ? { recentTurns } : {}),
                ...(options.voice ? { voice: options.voice(clientId) } : {}),
                ...(message.media ? { media: message.media } : {}),
            })).trim() || '我刚才没整理好，你再问我一次。';
            // 配对撤销可能发生在模型等待期间；旧请求不应把已清掉的上下文重新写回来，也不应把结果继续交给旧设备。
            if (generation !== resetGeneration) return { kind: 'text', text: '这台设备的配对已失效，请重新配对。' };
            if (options.sharedConversation) {
                options.sharedConversation.commit(clientId, question, reply, askedAt, now());
                return { kind: 'text', text: reply };
            }
            turns.push({ role: 'assistant', content: reply });
            if (!conversations.has(clientId) && conversations.size >= maxClients) {
                const oldest = conversations.keys().next().value as string | undefined;
                if (oldest !== undefined) conversations.delete(oldest);
            }
            conversations.delete(clientId);
            conversations.set(clientId, turns.slice(-maxTurns));
            return { kind: 'text', text: reply };
        },
        async onAction(request: PhoneActionRequest, clientId: string, requestId: string): Promise<ActionResult> {
            if (options.onAction) return options.onAction(request, clientId, requestId);
            return { requestId, ok: false, decision: 'deny', error: '手机动作需要宿主设备策略确认' };
        },
        onReset(clientId?: string): void {
            resetGeneration++;
            if (clientId) conversations.delete(clientId);
            else conversations.clear();
        },
    };
}
