// 「做题式」写法作为解释器的模块（ADR 0336 第 5 步）：ADR 0146 的实验，只有模拟器的 `--frame solve` 用，线上没有这个开关、App 不挂。
// 不让她演自己，让她推断这个情境里最可能发出的那几条；往「此刻」块的 solveFrame 槽放一句。主动找他、危机的轮次不放。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（模拟器那一路由 sim.test.ts 兜，行为基线走 App、碰不到）。

import type { Module } from '../interpreter/interpreter.ts';

/** 写法里不引任何她不该说的句子（提示词里引了模型会照抄） */
export const SOLVE_FRAME_NOTE = '这一轮不要去想怎么显得像真人，也不要演。只做一件事：根据上面的一切（你是谁、此刻的状态、聊天记录、他刚说的话），推断在这个情境里你最可能真的发出去的那几条消息——最普通、最不费力、最贴着语境的那一版，不是最精彩、最周全的那一版。只输出这几条消息，每条一行';

export function solveFrameModule(): Module {
    return {
        id: 'solve-frame',
        contribute(turn) {
            if (turn.initiate || turn.facts.crisis) return [];
            return [{ slot: 'solveFrame', text: SOLVE_FRAME_NOTE }];
        },
    };
}
