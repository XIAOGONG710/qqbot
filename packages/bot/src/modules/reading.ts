// 先读懂他这一轮在说什么，作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-30 加的一行，往「此刻」块的 reading 槽放、不存状态、不调模型。
// 连着发的几条算一句、「这个/那个」可能指什么摆出来、他前面已经答过的别再问（规则在 language/reading.ts）。
// 只给男朋友档；只想一想（不是在回他）、危机时不放。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { readingLine, readTurn } from '../language/reading.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放：只有男朋友档；只想一想、危机时不放 */
export function readingAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.thinking && !turn.facts.crisis;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function readingModule(log: Log): Module {
    return {
        id: 'reading',
        contribute(turn) {
            if (!readingAllowed(turn)) return [];
            const line = readingLine(readTurn(turn.history));
            if (!line) return [];
            log(`[${turn.contact.qq}] 他这句：这一轮先把他的话读明白再回（日志不记内容）`);
            return [{ slot: 'reading', text: line }];
        },
    };
}
