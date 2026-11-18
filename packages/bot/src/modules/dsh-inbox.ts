// DSH 收件箱的定时同步作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 30 秒把 DSH 追加的脱敏收件箱收进时间线 / 世界账。
// 怎么收还在 app.ts（syncDshInboxes）；启动时立刻收的那一次也在原位。DSH 开着、有时间线或世界账时才挂。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在世界维护之后、口味之前。

import type { Module } from '../interpreter/interpreter.ts';

export const DSH_INBOX_SYNC_MS = 30_000;

export function dshInboxModule(sync: (() => void) | undefined): Module {
    return { id: 'dsh-inbox', schedules: sync ? [{ every: DSH_INBOX_SYNC_MS, run: sync, start: 'built' }] : [] };
}
