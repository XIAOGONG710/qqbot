// 待跟进的事的定时同步作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 MEMORY_SYNC_MS 让各联系人的主动消息计划器从聊天里抽一遍「待跟进」。
// 怎么抽还在计划器里（proactive-planner 的 syncFollowUps）；连上之后立刻同步的那一次在原位。
// 计划器是连上之后才建的（主动消息开着才有）：定时任务在开的那一刻才看有没有计划器（schedules 是取值时现算的），没有就不开——和迁移前「建了计划器才开」一样。
// 定时（start: 'synced'）：连上、补完漏掉的消息之后；排在所有 synced 的最前面（迁移前它在建计划器时就开，比别的连上后的计时器都早）。

import type { Module, ScheduleSpec } from '../interpreter/interpreter.ts';

export function followUpsModule(sync: () => void, active: () => boolean, every: number): Module {
    return {
        id: 'follow-ups',
        get schedules(): ScheduleSpec[] {
            return active() ? [{ every, run: sync, start: 'synced' }] : [];
        },
    };
}
