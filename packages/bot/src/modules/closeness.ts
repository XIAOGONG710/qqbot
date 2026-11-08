// 关系阶段（ADR 0113）作为解释器的模块（ADR 0336 第 5 步）：最近一个月几乎天天在聊，她对男朋友更放得开一点，往「此刻」块的 closeness 槽放一行。
// 不存状态、不调模型，每一轮从聊天记录往回推（规则在 language/relationship.ts）。
// 让路和小梗那几样不一样：主动找他、他难过时照样放；只有男朋友档，只想一想、危机、小别扭时不放。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 closeness 场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { describeCloseness } from '../language/relationship.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放关系阶段：只有男朋友档；只想一想、危机、小别扭时不放 */
export function closenessAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.thinking && !turn.facts.crisis && !turn.facts.grievance;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function closenessModule(log: Log): Module {
    return {
        id: 'closeness',
        contribute(turn) {
            if (!closenessAllowed(turn)) return [];
            const line = describeCloseness(turn.history, turn.at.getTime());
            if (!line) return [];
            log(`[${turn.contact.qq}] 关系：最近几乎天天在聊，她更放得开一点（提示词里多一行）`);
            return [{ slot: 'closeness', text: line }];
        },
    };
}
