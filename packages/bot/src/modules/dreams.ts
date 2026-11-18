// 做梦那一拍作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 30 分钟一拍，同一拍里一起起做梦、午睡的小梦、一个月的回看、学习问题（life/dream-jobs.ts）。
// 只给男朋友档、开了心境（herFeelings）时挂——和迁移前 app.ts 的条件一样，由 App 决定给不给 tick。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在「她自己想一想的那几样」之后（同一刻到点的按开的先后触发，行为基线核对）。
// 读梦、读问题放进提示词的那一半在 feelings（decideAt.dream）和 learning-question 模块里。

import type { Module } from '../interpreter/interpreter.ts';

export const DREAMS_TICK_MS = 30 * 60_000;

export function dreamsModule(tick: (() => void) | undefined): Module {
    return { id: 'dreams', schedules: tick ? [{ every: DREAMS_TICK_MS, run: tick, start: 'built' }] : [] };
}
