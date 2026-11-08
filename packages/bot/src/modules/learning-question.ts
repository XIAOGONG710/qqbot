// 她学的时候没想通的地方，作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-31（用户：「她现在的说话方式还在学习，可是她学的不会的没有问过我」）。
// 这次只迁「放进提示词」的那一半：她最近存下的那个没想通的问题（两天内的），往「此刻」块的 question 槽放一行，想问就问他。
// 想出这个问题、存进 <数据目录>/learning-questions.json 的那一半还在 app.ts 夜里的计时器里，迁那个计时器时一起收。
// 只给男朋友档；危机、只想一想时不放。规则在 life/learning-questions.ts。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）；读问题的时刻从算意图之前挪到了拼段落时，见 ADR 0336。

import type { Module } from '../interpreter/interpreter.ts';

/** questionOf：这一刻要给她看的那一行（App 从数据目录现读，过期的不给）；没有就是 undefined */
export function learningQuestionModule(questionOf: () => string | undefined): Module {
    return {
        id: 'learning-question',
        contribute(turn) {
            if (turn.contact.tier !== 'boyfriend' || turn.facts.crisis || turn.thinking) return [];
            const line = questionOf();
            return line ? [{ slot: 'question', text: line }] : [];
        },
    };
}
