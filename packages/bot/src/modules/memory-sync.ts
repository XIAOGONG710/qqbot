// 长期记忆的定时同步作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 MEMORY_SYNC_MS 把各联系人新的聊天交给长期记忆、补日记、同步答应的事。
// 同步做什么还在 app.ts（syncMemory：休眠时不做、出错走收消息的失败处理）；连上之后立刻同步的那一次也在原位。开了长期记忆才挂。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在 NOW、outbox 之前。

import type { Module } from '../interpreter/interpreter.ts';

export function memorySyncModule(sync: (() => void) | undefined, every: number): Module {
    return { id: 'memory-sync', schedules: sync ? [{ every, run: sync, start: 'built' }] : [] };
}
