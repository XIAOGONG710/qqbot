// 她的口味（ADR 0162）定时回头看一看作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每小时来看一眼要不要看（一天最多一次，间隔在 tastes.ts 里），
// 启动两分钟后先看一次（一次性的那个）。看什么、怎么记还在 app.ts（Tastes.reflect）；开了 tastes 才挂。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，先周期的、再一次性的，排在 DSH 收件箱之后、记忆同步之前。

import type { Module } from '../interpreter/interpreter.ts';

export const TASTES_CHECK_MS = 3_600_000;
export const TASTES_FIRST_MS = 120_000;

export function tastesModule(reflect: (() => void) | undefined): Module {
    return {
        id: 'tastes',
        schedules: reflect ? [
            { every: TASTES_CHECK_MS, run: reflect, start: 'built' },
            { every: TASTES_FIRST_MS, run: reflect, start: 'built', once: true },
        ] : [],
    };
}
