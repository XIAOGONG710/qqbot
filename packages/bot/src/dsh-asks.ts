import { sanitizeDshError, type DshConversationTurn, type DshLink, type DshState, type DshVoice } from './dsh-link.ts';
import type { DshConversationContext } from './dsh-continuity.ts';

// 「/dsh ask …」「/dsh talk …」：他显式请 DSH 顾问回答一个问题，回答原样作为提示发给他。
// 一次只问一个、按先后排队；停止时不再发新的回答，在途的那一问取消，等队尾收完。
// 原来在 app.ts 里（askDsh / stopDshAsks），ADR 0336 第 6 步原样搬到这里。
export interface DshAsksDeps {
    stopped: () => boolean;
    now: () => number;
    link: Pick<DshLink, 'advise'>;
    /** 她现在的状态（同桌面读的 STATE.json） */
    state: () => DshState | undefined;
    /** 最近几轮 /dsh 问答（只在显式问的时候带上） */
    recentTurns: () => readonly DshConversationTurn[] | undefined;
    voice: () => DshVoice | undefined;
    conversation: Pick<DshConversationContext, 'commit'>;
    /** 给他发一句提示 */
    tellOwner: (text: string) => void;
}

export interface DshAsks {
    ask(question: string): void;
    /** 停：取消在途的、不再发新回答；有排着的就返回等它们收完 */
    stop(): Promise<void> | undefined;
}

export function dshAsks({ stopped, now, link, state, recentTurns, voice, conversation, tellOwner }: DshAsksDeps): DshAsks {
    let dshAskTail: Promise<void> = Promise.resolve();
    let dshAskPending = 0;
    const dshAskLifetime = new AbortController();
    return {
        ask(question) {
            const askedAt = now();
            dshAskPending++;
            dshAskTail = dshAskTail.then(async () => {
                if (stopped() || dshAskLifetime.signal.aborted) return;
                try {
                    const continuity = recentTurns();
                    const request = Promise.resolve(link.advise({ question, state: state(), recentTurns: continuity, voice: voice() }))
                        .then(reply => ({ kind: 'reply' as const, reply }), error => ({ kind: 'error' as const, error }));
                    let onAbort: (() => void) | undefined;
                    const cancelled = new Promise<{ kind: 'cancelled' }>(resolve => {
                        if (dshAskLifetime.signal.aborted) resolve({ kind: 'cancelled' });
                        else {
                            onAbort = () => resolve({ kind: 'cancelled' });
                            dshAskLifetime.signal.addEventListener('abort', onAbort, { once: true });
                        }
                    });
                    const outcome = await Promise.race([request, cancelled]);
                    if (onAbort) dshAskLifetime.signal.removeEventListener('abort', onAbort);
                    if (outcome.kind === 'cancelled' || stopped() || dshAskLifetime.signal.aborted) return;
                    if (outcome.kind === 'error') throw outcome.error;
                    const reply = outcome.reply;
                    const text = reply.trim() || '我刚才没整理好，你再问我一次。';
                    conversation.commit(question, text, askedAt, now());
                    tellOwner(text);
                } catch (error) {
                    if (!stopped() && !dshAskLifetime.signal.aborted) tellOwner(`（DSH 咨询失败：${sanitizeDshError(error)}）`);
                }
            }).finally(() => { dshAskPending--; });
        },
        stop() {
            dshAskLifetime.abort();
            return dshAskPending ? dshAskTail : undefined;
        },
    };
}
