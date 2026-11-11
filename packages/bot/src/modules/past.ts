// 她的过去（ADR 0022）作为解释器的模块（ADR 0336 第 5 步）：
// 他这次的话里出现卡上某块自传的线索，就把那几块（留白带说明）和这一档看得到的年表放进聊天记录之后的 past 槽；
// 刚想起过的，接下来没有新线索也沿用一会儿（追问「那后来呢」本身没有线索；从聊天记录往回推，不记在内存里，ADR 0039）。
// 自传按档位分（卡是转换器裁好的），所以用这一轮的卡（turn.card）；各档位都放，危机回合照样放；主动找他时不想（没有「他这次说的」）。
// 不存状态、不调模型，没有开关（卡上有自传就有）。线索和写法的规则都在 life/biography.ts、life/people.ts（lingering），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 past 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { describePast, pastCue } from '../life/biography.ts';
import { lingering } from '../life/people.ts';
import type { Log } from '../platform/log.ts';

/** log 同联系人流水线的日志，前面加 [QQ] */
export function pastModule(log: Log): Module {
    return {
        id: 'past',
        contribute(turn) {
            const biography = turn.card?.biography;
            if (!biography || turn.initiate) return [];
            let chunks = pastCue(turn.history, biography);
            if (chunks.length) {
                log(`[${turn.contact.qq}] 想起从前：${chunks.map(chunk => chunk.title).join('、')}`);
            } else {
                // 线索认出来的是空列表时算没有（lingering 接着往前找）
                chunks = lingering(turn.history, turn.at.getTime(), upTo => { const found = pastCue(upTo, biography); return found.length ? found : undefined; })?.found ?? [];
                if (chunks.length) log(`[${turn.contact.qq}] 从前沿用刚才想起的：${chunks.map(chunk => chunk.title).join('、')}`);
            }
            const text = describePast(chunks, biography);
            return text ? [{ slot: 'past', text }] : [];
        },
    };
}
