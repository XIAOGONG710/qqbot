// 发出去之前的修饰作为解释器的模块（ADR 0336「生成之后那一段」第 11 步）：拆好条之后、发出去之前，按修饰顺序表（DECORATE_STAGES）打错字。
// 原来排在前面的质感（ADR 0131 / 0134，配置 texture）随 fewerRules 转正删了（2026-11-24，减法单子 二.1；线上 fewerRules 开着时本来就关着）。
// - 打错字再改口（ADR 0024 / 0086）：偶尔打错一个字，下一条补「*对的词」，能撤回时（ctx.canRecall）按比例改成撤回重发。
// 种子只看是谁、拆好条的原稿说了什么，不看时间：同一句话结果固定（带时间时假模型的测试时过时不过）。危机回合（turn.facts.crisis）不做（ADR 0068）。
// 不存状态、不调模型、同步。行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { maybeTypo, RECALL_SHARE } from '../language/expression.ts';

/** 打错字再改口：没有开关，App 和模拟器都总是挂 */
export function typoModule(): Module {
    return {
        id: 'typo',
        decorateAt: {
            typo: (parts, turn, ctx) => {
                if (turn.facts.crisis) return parts;
                const typo = maybeTypo(parts, `${turn.contact.qq} ${ctx.original.join('|')}`, ctx.maxBubbles, ctx.canRecall ? RECALL_SHARE : 0);
                if (typo.note) ctx.log(`打错字：${typo.note}`);
                return typo.recall ? { parts: typo.parts, recall: typo.recall } : typo.parts;
            },
        },
    };
}
