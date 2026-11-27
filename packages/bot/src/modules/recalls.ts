import type { Module } from '../interpreter/interpreter.ts';
import type { AppConfig, Contact } from '../platform/config.ts';
import type { ChatHistory } from '../memory/history.ts';
import { detectCrisis } from '../emotion/crisis.ts';

// 他撤回了一条消息：还没回的那条记成「撤回了一条消息」，待处理的保存撤回意图，再让记忆跟上（不把撤回前的正文交给记忆）。
// 原来是 app.ts 里 App 的 receiveRecall，ADR 0336 第 6 步原样搬成解释器的模块（接 recall 事件）。
export interface RecallDeps {
    config: Pick<AppConfig, 'recalls' | 'contacts'>;
    stopped: () => boolean;
    chatHistory: Pick<ChatHistory, 'recallRevision' | 'recall' | 'pendingIncoming'>;
    /** 开了长期记忆没有 */
    hasMemory: boolean;
    /** 记忆那边先知道有撤回（屏障），读不到聊天记录时抛出 */
    observeRecalledMemory: (contact: Contact) => void;
    /** 有撤回待同步时，让这个人的记忆跟上 */
    syncRecalledMemory: (qq: number) => void;
    withdrawUnderstanding?: (qq: number, messageId: number) => void;
    incomingFailure: (error: unknown) => void;
    log: (message: string) => void;
}

// App 里解释器建得比聊天记录、记忆早，所以给的是取它们的函数，事件来了才取（事件都在 App 搭好之后才来）。
export function recallsModule(depsNow: () => RecallDeps): Module {
    return {
        id: 'recalls',
        on: {
            recall: ({ event }) => {
                const { config, stopped, chatHistory, hasMemory, observeRecalledMemory, syncRecalledMemory, withdrawUnderstanding, incomingFailure, log } = depsNow();
                if (stopped() || !config.recalls) return;
                const contact = config.contacts.find(c => c.qq === event.user_id);
                if (!contact) return;
                const before = chatHistory.recallRevision(contact.qq);
                // 想伤害自己的话撤回了也照样看到（安全比像人优先，ADR 0068）；回过的她已经看过
                try {
                    if (chatHistory.recall(contact.qq, event.message_id, content => Boolean(detectCrisis(content)))) {
                        try { withdrawUnderstanding?.(contact.qq, event.message_id); }
                        catch (error) { incomingFailure(error); }
                        observeRecalledMemory(contact);
                        const pending = chatHistory.pendingIncoming(contact.qq).some(entry => entry.withdrawn && entry.source.messageId === event.message_id);
                        log(pending ? `[${contact.qq}] 他撤回了一条待处理消息，已保存撤回意图` : `[${contact.qq}] 他撤回了一条还没回的消息，记成「撤回了一条消息」`);
                    }
                    syncRecalledMemory(contact.qq);
                } catch (error) {
                    // 只有RAM已经接受的新观察才需要记忆更新；单纯读错不能授权同步旧正文。
                    if (hasMemory && chatHistory.recallRevision(contact.qq) !== before) {
                        try { observeRecalledMemory(contact); } catch (guardError) { incomingFailure(guardError); }
                    }
                    incomingFailure(error);
                }
            },
        },
    };
}
