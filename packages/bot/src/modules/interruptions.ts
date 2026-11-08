// 被第三方打断（ADR 0115）作为解释器的模块（ADR 0336 第 5 步）：聊天正在进行时，她那边世界账里恰好发生了一件小事——
// assess 时写进 turn.facts.interruption（旧逻辑读它：这一轮不带意图 / 深思 / 形状 / 长短），contribute 时往「此刻」块的 interrupt 槽放一行。
// 她那边此刻的样子（turn.facts.world）由旧逻辑写入；让路规则同小梗（modules/playful.ts）。不存状态、不调模型。
// 挑哪件、多少比例的规则都在 language/interruption.ts，这里只是接线；行为和迁移前 contact.ts 里的逐字一样（行为基线 interruptions 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { describeInterruption, interruptionNow } from '../language/interruption.ts';
import type { Log } from '../platform/log.ts';
import { playfulAllowed } from './playful.ts';

/** log 同联系人流水线的日志，前面加 [QQ] */
export function interruptionsModule(log: Log): Module {
    return {
        id: 'interruptions',
        // 先判断（旧逻辑读 turn.facts.interruption：这一轮不带意图 / 深思 / 形状 / 长短，免得把打断吞掉）
        assess(turn) {
            const { world } = turn.facts;
            if (!world || !playfulAllowed(turn)) return;
            const interruption = interruptionNow(world.events, turn.history, turn.at.getTime());
            if (!interruption) return;
            turn.facts.interruption = interruption;
            log(`[${turn.contact.qq}] 被打断：聊着的时候她那边发生了一件小事（提示词里多一行；日志不记内容）`);
        },
        contribute(turn) {
            const { interruption } = turn.facts;
            return interruption ? [{ slot: 'interrupt', text: describeInterruption(interruption) }] : [];
        },
    };
}
