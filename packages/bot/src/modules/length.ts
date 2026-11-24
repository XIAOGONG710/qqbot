// 长短不一作为解释器的模块（ADR 0336 第 5 步）：ADR 0024——偶尔回句短的、偶尔话多一点（按他最后一句的哈希抽，同一句每次一样）；心情低的日子不加「话多」。
// 放进「此刻」块的 length 槽。危机、问到过去 / 节日的线索、只发表情、发照片、被打断、只想一想、深思的轮次不给（由别的那几样管长短）。
// 「她这会儿低落不低落」（facts.low）原来是形状模块（modules/shape.ts）的 decideAt.length 算的，形状控制随 fewerRules 转正删了（2026-11-24，
// 减法单子 二.1），这一步原样搬到这里（同一个判断位置：深思之后、拼段落之前），长短照旧读它。不存状态、不调模型。

import { feelsLow } from '../emotion/feelings.ts';
import type { Module } from '../interpreter/interpreter.ts';
import { unwell } from '../life/body.ts';
import { moodAt } from '../life/her-days.ts';
import { describeLength, lengthHint } from '../language/expression.ts';
import type { Log } from '../platform/log.ts';

export interface LengthModuleOptions {
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function lengthModule(options: LengthModuleOptions): Module {
    return {
        id: 'length',
        // 她这会儿低落：今天的心情是「安静」、身体不舒服、心境那一行放了而且偏低、真人数值低（没劲 / 饿 / 压力大 / 心情差）——不加「话多」。
        // 今天的心情在这里现算（按日子哈希，纯函数；作息经 DecideCtx 给，没开她自己的日子就没有心情）。
        decideAt: {
            length: (turn, ctx) => {
                const { facts, at: time } = turn;
                const { world: around, body: bodyNow, humanValues } = facts;
                const mood = ctx.schedule ? moodAt(ctx.schedule, turn.card?.moods ?? [], time, ctx.mood, { body: bodyNow, world: around }) : undefined;
                const low = mood?.mood.name === '安静' || (bodyNow ? unwell(bodyNow) : false) || (facts.feelingLine !== undefined && feelsLow(facts.felt ?? []))
                    || Boolean(humanValues && (humanValues.energy <= 30 || humanValues.hunger >= 82 || humanValues.stress >= 78 || humanValues.mood <= 30));
                if (low) facts.low = true;
            },
        },
        contribute(turn) {
            const { facts } = turn;
            if (facts.crisis || facts.cue || facts.stickerOnly || facts.photo || facts.interruption || turn.thinking || facts.deliberate) return [];
            const length = lengthHint({
                history: turn.history, intent: facts.intent, initiating: Boolean(turn.initiate), low: Boolean(facts.low),
            });
            if (!length) return [];
            options.log(`[${turn.contact.qq}] 这一轮说话：${length === 'short' ? '回句短的' : '话多一点'}`);
            return [{ slot: 'length', text: describeLength(length) }];
        },
    };
}
