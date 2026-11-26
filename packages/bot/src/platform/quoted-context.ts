import type { Executor } from '../executor/executor.ts';
import type { ChatHistory } from '../memory/history.ts';
import type { Log } from './log.ts';
import { isDesktopManualMessage, quotedIds, renderForward, segmentsToText, type ForwardLookup, type QuotedMessage, type QuoteLookup, type Segment } from './onebot.ts';

// 他引用的那一条、他转发的聊天记录：记录里没有的先问 NapCat 补上，转文字时按 id 找回来（ADR 0081；11-02「检查类似的问题」）。
// 收消息、补回漏掉的消息、恢复入站都用同一份（两张缓存表在这里）。
// 原来在 app.ts（quoteLookup / missingQuotes / fetchQuotes / missingForwards / fetchForwards / forwardLookup），ADR 0336 第 6 步原样搬到这里。
export interface QuotedContextDeps {
    transport: Pick<Executor['qq'], 'callAction'>;
    history: Pick<ChatHistory, 'load'>;
    /** 她自己的 QQ 号（连上之后才知道；0 = 还不知道） */
    selfId: () => number;
    log: Log;
}

/** 一条消息里最多替几个引用 / 几段转发去问 NapCat */
export const MAX_FETCH_PER_MESSAGE = 3;

export function quotedContext({ transport, history, selfId, log }: QuotedContextDeps) {
    /** 他引用回复时，被引用的那一条在聊天记录里（按 QQ 消息 id；ADR 0081）；不在记录里的，问过 NapCat 的从 fetchedQuotes 拿 */
    const quoteLookup = (qq: number): QuoteLookup => id => {
        const found = history.load(qq).findLast(message => message.messageId === id);
        return found ? { role: found.role, content: found.content } : fetchedQuotes.get(quoteKey(qq, id));
    };

    /**
     * 引用的那一条不在聊天记录里时问 NapCat（get_msg）补上（11-02 线上：他 11:24 引用她那句自我介绍问「你这是说谁呢」，
     * 那会儿服务在重启，这条是之后补回的，引用在记录里没对上，她只看到「你这是说谁呢」，答成「说你呢」）。
     * 只认这段私聊里的两个人：发的人是她自己（小号）就是她说的，是对方就是他说的；认不出来的不猜
     */
    // 按「这段私聊 + 消息 id」记（2026-11-26 入站审查）：他是他说的、你是你说的，是按问的那一段私聊认的；换一段私聊不能拿来用
    const fetchedQuotes = new Map<string, QuotedMessage>();
    const quoteKey = (qq: number, id: number) => `${qq}:${id}`;
    function missingQuotes(qq: number, message: Segment[] | string): number[] {
        if (!transport.callAction) return [];
        const ids = quotedIds(message);
        if (!ids.length) return [];
        const known = new Set(history.load(qq).map(m => m.messageId));
        // 一条消息正常只有一个引用段；拼出来的消息塞几百个，每个都要排队问一次 NapCat（2026-11-26 入站审查），最多问前几个
        return [...new Set(ids)].filter(id => !known.has(id) && !fetchedQuotes.has(quoteKey(qq, id))).slice(0, MAX_FETCH_PER_MESSAGE);
    }
    async function fetchQuotes(qq: number, ids: readonly number[], self: number = selfId()): Promise<void> {
        for (const id of ids) {
            try {
                const got = await transport.callAction!('get_msg', { message_id: id }) as { message_type?: string; user_id?: number; sender?: { user_id?: number }; message?: Segment[] | string } | undefined;
                const from = got?.sender?.user_id ?? got?.user_id;
                if (got?.message && isDesktopManualMessage(got.message, from, self)) continue;
                // 私聊里引用的只会是私聊里的消息；问回来是群消息的（发的人恰好也是他 / 她）不认
                const role = got?.message_type === 'group' ? undefined : from === qq ? 'user' : self && from === self ? 'assistant' : undefined;
                const content = got?.message ? segmentsToText(got.message).replace(/\s+/g, ' ').trim() : '';
                if (!role || !content) { log(`[${qq}] 引用的那一条记录里没有，问 NapCat 也没认出来`); continue; }
                fetchedQuotes.set(quoteKey(qq, id), { role, content });
                if (fetchedQuotes.size > 200) fetchedQuotes.delete(fetchedQuotes.keys().next().value!);
                log(`[${qq}] 引用的那一条记录里没有，问 NapCat 补上了（${role === 'assistant' ? '她说的' : '他说的'}）`);
            } catch (error) {
                log(`[${qq}] 引用的那一条记录里没有，问 NapCat 没拿到：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    /**
     * 合并转发里的内容（11-02「检查类似的问题」）：forward 段自己带了 content 就用它，只有 id 的问 NapCat（get_forward_msg）；
     * 写的时候他写「他」、她自己写「你」、别人写昵称（renderForward），不把别人的话写成他的。取不到照旧只写「[转发的聊天记录]」
     */
    const fetchedForwards = new Map<string, unknown[]>();
    function missingForwards(message: Segment[] | string): string[] {
        if (!transport.callAction || typeof message === 'string') return [];
        return message.filter(segment => segment.type === 'forward' && !Array.isArray(segment.data?.content))
            .map(segment => String(segment.data?.id ?? '')).filter(id => id && !fetchedForwards.has(id)).slice(0, MAX_FETCH_PER_MESSAGE);
    }
    async function fetchForwards(qq: number, ids: readonly string[]): Promise<void> {
        for (const id of ids) {
            try {
                const got = await transport.callAction!('get_forward_msg', { message_id: id }) as { messages?: unknown[] } | undefined;
                if (!Array.isArray(got?.messages) || !got.messages.length) { log(`[${qq}] 转发的聊天记录问 NapCat 没拿到内容`); continue; }
                fetchedForwards.set(id, got.messages);
                if (fetchedForwards.size > 50) fetchedForwards.delete(fetchedForwards.keys().next().value!);
                log(`[${qq}] 转发的聊天记录问 NapCat 拿到了 ${got.messages.length} 条（日志不记内容）`);
            } catch (error) {
                log(`[${qq}] 转发的聊天记录问 NapCat 没拿到：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    const forwardLookup = (qq: number, self: number = selfId()): ForwardLookup => data => {
        const items = Array.isArray(data.content) ? data.content as unknown[] : fetchedForwards.get(String(data.id ?? ''));
        if (!items) return undefined;
        return renderForward(items, (userId, nickname) => (userId === qq ? '他' : self && userId === self ? '你' : nickname || '别人'), self);
    };

    return { quoteLookup, missingQuotes, fetchQuotes, missingForwards, fetchForwards, forwardLookup };
}
