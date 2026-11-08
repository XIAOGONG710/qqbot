// 场景应答作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-31 从她自己的聊天诊断里挑出来的几处「该接的没接」，
// 他这句命中时往「此刻」块的 scene 槽放一句（哄睡、讲代码报错、担心她看不起他、看不懂的缩写；规则在 language/scenes.ts）。
// 只看他最后一句，只给男朋友档，危机时不放；主动找他、只想一想的轮次照样放（他最后那句还在那儿）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 scenes 场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { readScene } from '../language/scenes.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放：只有男朋友档，危机时不放 */
export function scenesAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.facts.crisis;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function scenesModule(log: Log): Module {
    return {
        id: 'scenes',
        contribute(turn) {
            if (!scenesAllowed(turn)) return [];
            const hisLast = turn.history.filter(message => message.role === 'user').slice(-1)[0]?.content ?? '';
            const line = readScene(hisLast)?.line;
            if (!line) return [];
            log(`[${turn.contact.qq}] 场景：他这句要特殊接（哄睡 / 报错 / 自我怀疑 / 暗号）`);
            return [{ slot: 'scene', text: line }];
        },
    };
}
