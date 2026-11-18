// 走开前说一声作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 3 分钟看一眼她那边是不是要去洗澡 / 上课了（life/leave-note.ts 的 leaveAnnouncer）。
// 主动消息没关、有男朋友档、有生活执行器时才挂——和迁移前 app.ts 的条件一样，由 App 决定给不给 check。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在做梦那一拍之后。

import type { Module } from '../interpreter/interpreter.ts';

export const LEAVE_CHECK_MS = 3 * 60_000;

export function leaveNoteModule(check: (() => Promise<void>) | undefined): Module {
    return { id: 'leave-note', schedules: check ? [{ every: LEAVE_CHECK_MS, run: () => { void check(); }, start: 'built' }] : [] };
}
