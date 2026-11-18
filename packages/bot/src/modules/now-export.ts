// 「她现在在干嘛」（NOW.md，任务书 §2）的定时导出作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 NOW_REFRESH_MS 重写一次，桌面上的她只读它。
// 怎么渲染还在 app.ts（exportNow：作息 + 她自己的安排 + 聊天中断层 + 世界里已经发生的事）；启动时立刻写的那一次也在原位。总是挂（没有作息时 exportNow 自己什么都不写）。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在记忆同步之后、outbox 之前。

import type { Module } from '../interpreter/interpreter.ts';

export function nowExportModule(exportNow: () => void, every: number): Module {
    return { id: 'now-export', schedules: [{ every, run: exportNow, start: 'built' }] };
}
