// 长短不一作为解释器的模块（ADR 0336 第 5 步）：ADR 0024——偶尔回句短的、偶尔话多一点（按他最后一句的哈希抽，同一句每次一样）；心情低的日子不加「话多」。
// 放进「此刻」块的 length 槽。危机、形状生效、问到过去 / 节日的线索、只发表情、发照片、被打断、只想一想、深思的轮次不给（由别的那几样管长短）。
// 这一组（照片 → 意图 → 心境 → 图片表情 → 深思 → 引用 → 形状 → 长短）有固定的先后、中间要抽随机数，从末端倒着迁：
// 前面那几样还在旧逻辑里，旧逻辑在拼段落之前把它们写进 turn.facts，这里只读。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { describeLength, lengthHint } from '../language/expression.ts';
import type { Log } from '../platform/log.ts';

export interface LengthModuleOptions {
    /** 说话更短（配置 shortReplies）：「回句短的」的说法和概率跟着变 */
    shortReplies?: boolean;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function lengthModule(options: LengthModuleOptions): Module {
    return {
        id: 'length',
        contribute(turn) {
            const { facts } = turn;
            if (facts.crisis || facts.shape || facts.cue || facts.stickerOnly || facts.photo || facts.interruption || turn.thinking || facts.deliberate) return [];
            const length = lengthHint({
                history: turn.history, intent: facts.intent, initiating: Boolean(turn.initiate), low: Boolean(facts.low),
                aboutPerson: Boolean(facts.aboutPeople), shortReplies: options.shortReplies,
            });
            if (!length) return [];
            options.log(`[${turn.contact.qq}] 这一轮说话：${length === 'short' ? '回句短的' : '话多一点'}`);
            return [{ slot: 'length', text: describeLength(length, options.shortReplies) }];
        },
    };
}
