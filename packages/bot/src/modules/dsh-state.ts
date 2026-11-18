// DSH 状态快照的定时导出作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 NOW_REFRESH_MS 把脱敏的状态摘要写到灵魂目录的 STATE.json。
// 摘要怎么算、写不写还在 app.ts（exportDshState，读世界账、需要值、照片草稿）；启动时立刻写的那一次也在原位。DSH 开着才挂。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在走开前说一声之后。

import type { Module } from '../interpreter/interpreter.ts';

export function dshStateModule(exportState: (() => void) | undefined, every: number): Module {
    return { id: 'dsh-state', schedules: exportState ? [{ every, run: exportState, start: 'built' }] : [] };
}
