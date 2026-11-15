// 这一轮的意图行和「/亲热」那一行作为解释器的模块（ADR 0336 第 5 步）——都是「这一轮你想怎么接」的话：
// - intent（ADR 0019 起）：意图阶梯（modules/intent.ts）在 assess 时写 facts.baseIntent，再在 decideAt.intent 按照片、被打断改写成这一轮最终的意图（facts.intent）；
//   深思的轮次（ADR 0151 / 0202，facts.deliberate）只管「怎么答」的那一句（先直接回答他刚问的 / 很大很抽象的问题）由深思那一句代替，不放；
//   追着要答案、说她不像真人这类纠偏的意图行照放。
// - intimate（ADR 0170）：他刚发过「/亲热」，接下来几条回复里放一行让她黏一点。
//
// 意图行是纯函数：只看 facts.intent 和 facts.deliberate。两样都是联系人流水线在拼段落之前写的（写的地方：意图在照片 / 被打断改写之后，
// 深思在语义路由那次 await 之后，都写在同一个 Object.assign 里），之后没有模块再改，这里在 contribute 时算和迁移前原位算一样。
// 「/亲热」那一行留在原位取：每取一次扣一条、写状态文件（intimacy.json），主动找他、危机回合不取；取到的写进 facts.intimateLine，这里只放。
// 这一行和「QQ 文字里的抱抱」那条出口检查（textIntimacy）无关，那条读的是意图。
// 不存状态、不调模型。同步返回，不多等一个微任务（行为基线核对事件顺序）。「亲热」那行日志留在原位。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';

/** 深思时由「先想清楚」那一句代替的意图行：只管怎么答的那两种 */
const ANSWER_HOW = /先直接回答他刚问的|他在问一个很大、很抽象的问题/;

/** 这几样由联系人流水线写进 turn.facts，这里只读（字段说明见 interpreter.ts 的 TurnFacts） */
export type IntentLineFacts = Pick<TurnFacts, 'intimateLine'>;

export function intentLineModule(): Module {
    return {
        id: 'intent-line',
        contribute(turn) {
            const facts = turn.facts;
            const pieces: Piece[] = [];
            const intent = facts.intent;
            if (intent && !(facts.deliberate && ANSWER_HOW.test(intent))) pieces.push({ slot: 'intent', text: intent });
            if (facts.intimateLine) pieces.push({ slot: 'intimate', text: facts.intimateLine });
            return pieces;
        },
    };
}
