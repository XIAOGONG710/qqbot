// 她自己的问题和判断作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-31 加的三行，往「此刻」块放、不存状态、不调模型。
// - askHint：多问她真的想知道的事（2026-10-31 用户：「我希望她能有更多的问题来问我」）——他这句里有能接着想的，给她一个问的方向（language/asks.ts 的 thinkHint）。
// - opinion：要有自己的判断（2026-10-31：实测最近 200 条她没有一条带「我觉得」）——他在问她怎么看时，给一句先表态的方向（language/opinion.ts 的 opinionHint）。
// - unsure：拿不准就直说「这个我拿不准」再问他，别编（language/asks.ts 的 UNSURE_LINE）。
// 都只看他最后一句，只给男朋友档，危机时不放；问的方向在她只想一想（内心）的轮次也不放。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）；规则都在 language/，这里只是接线。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { thinkHint, UNSURE_LINE } from '../language/asks.ts';
import { opinionHint } from '../language/opinion.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放这几行：只有男朋友档，危机时不放 */
export function asksAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.facts.crisis;
}

/** 他最后一句（没有就是空串，同迁移前） */
const hisLast = (turn: Turn) => turn.history.filter(message => message.role === 'user').slice(-1)[0]?.content ?? '';

/** log 同联系人流水线的日志，前面加 [QQ] */
export function asksModule(log: Log): Module {
    return {
        id: 'asks',
        contribute(turn) {
            if (!asksAllowed(turn)) return [];
            const said = hisLast(turn);
            const pieces: Piece[] = [];
            const ask = turn.thinking ? undefined : thinkHint(said);
            if (ask) {
                log(`[${turn.contact.qq}] 问一句：他这句${ask.why}，给她一个问的方向`);
                pieces.push({ slot: 'askHint', text: ask.line });
            }
            const opinion = opinionHint(said);
            if (opinion) {
                log(`[${turn.contact.qq}] 表态：他${opinion.why}，给一句先表态的方向`);
                pieces.push({ slot: 'opinion', text: opinion.line });
            }
            pieces.push({ slot: 'unsure', text: UNSURE_LINE });
            return pieces;
        },
    };
}
