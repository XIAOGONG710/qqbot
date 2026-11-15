// 真人数值和人格成长层作为解释器的模块（ADR 0336 第 5 步，「心境这一组：方案」第 2 步）：
// - humanState（ADR 0222）：这一刻的底色——累、饿、压着事、心情、想找人说话、跟他亲不亲……只给自然语言，不给分数（describeHumanState）。
// - development（ADR 0251）：她最近形成的生活脉络——在推进的人生线、这会儿更想恢复 / 专注 / 靠近、关系和情绪的走向（describeDevelopment）。
// 只想一想的轮次两行都不放（迁移前就是这样）；危机、主动找他照放（迁移前就不看这些）。
//
// 这一模块只放段落，不算：数值（options.humanValues，App 在有需要锚点和世界账时才给）和成长快照留在联系人流水线原来的位置
// （buildPrompt 开头、第一次 await 之前），算完写进 turn.facts，这里只读。不挪进 perceive 的原因：
// - 两样都要读世界账的事件（sharedWorld.events()），而带结算的世界账每读一次都会先按「此刻的墙上时间」结算一遍、可能落新的事件，还会写文件、记日志；
// - 原位置和 perceive 之间隔着长期记忆的几次 await（commonEntities、召回的 Promise.all、工作记忆、沿用、今天和别人聊过的）和 onHerDay（写当天的世界）。
//   线上这几次 await 要等真实的 Hindsight，墙上时间往前走、别的联系人的回合和定时推进也会在中间落事件；
//   成长快照的反思（reflectionLessons）不按时刻过滤事件，多一条失败 / 中断的事件，「生活脉络」那一行就多一句。行为基线的假时钟在 await 里不走，抓不到这种差别。
// - 「数值：……」「人格成长层：……」这两行日志原来排在召回日志之前，挪过去先后就变了。
// 所以按方案的退路：旧逻辑原位算、写 facts；describeHumanState / describeDevelopment 是纯函数（只读数值、快照和档位），挪到 contribute 时算结果一样。
// 不存状态、不调模型、不记日志。旧逻辑算 low（不加「话多」）时照旧读它自己算的数值。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { describeHumanState } from '../human-values.ts';
import { describeDevelopment } from '../life/development.ts';

export function humanStateModule(): Module {
    return {
        id: 'human-state',
        contribute(turn) {
            if (turn.thinking) return [];
            const { facts } = turn;
            const humanState = facts.humanValues ? describeHumanState(facts.humanValues, turn.contact.tier) : undefined;
            const development = facts.development ? describeDevelopment(facts.development) : undefined;
            const pieces: Piece[] = [];
            if (humanState) pieces.push({ slot: 'humanState', text: humanState });
            if (development) pieces.push({ slot: 'development', text: development });
            return pieces;
        },
    };
}
