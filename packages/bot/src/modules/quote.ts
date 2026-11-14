// 引用回复作为解释器的模块（ADR 0336 第 5 步）：ADR 0136——他连发里有个不是最后一条的问题，按比例（按那条消息的 id 哈希，不抽随机数）
// 第一条在 QQ 里引用它回；提示词里放一行（quote 槽），告诉她第一条先回那一句。
// 主动找他、只想一想、危机、只发表情 / 发照片、他难过（意图是先接住他此刻的情绪）的轮次不引用。
// 「照片 → … → 引用 → 形状 → 长短」这一串从末端倒着迁（见 modules/length.ts）：只发表情、发照片这些还在旧逻辑里，旧逻辑写进 turn.facts，这里读；
// 引用的是哪一条写回 turn.facts.quote，旧逻辑在拼完段落之后取回去，发送时真的引用那条消息。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { Log } from '../platform/log.ts';
import { describeQuote, planQuote } from '../social/quote-reply.ts';

export interface QuoteModuleOptions {
    /** 存下来的聊天记录（带 QQ 消息 id，引用要用） */
    history: (qq: number) => StoredMessage[];
    /** 引用的比例（只有模拟器的场景调；不给用 QUOTE_SHARE） */
    share?: number;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function quoteModule(options: QuoteModuleOptions): Module {
    return {
        id: 'quote',
        contribute(turn) {
            const { facts } = turn;
            if (turn.initiate || turn.thinking || facts.crisis || facts.stickerOnly || facts.photo || (facts.baseIntent && /先接住他此刻的情绪/.test(facts.baseIntent))) return [];
            const plan = planQuote(options.history(turn.contact.qq), turn.contact.qq, options.share);
            if (!plan) return [];
            facts.quote = plan;
            options.log(`[${turn.contact.qq}] 引用回复：这一轮第一条引用他连发里的一个问题（日志不记内容）`);
            return [{ slot: 'quote', text: describeQuote(plan) }];
        },
    };
}
