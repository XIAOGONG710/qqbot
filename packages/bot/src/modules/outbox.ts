// 她自己想让他知道的事（OUTBOX.jsonl，ADR 0174）的定时投递作为解释器的模块（ADR 0336 第 6 步「计时器迁成模块的 schedules」）：每 30 秒看一眼有没有留话、能不能发。
// 拦不拦（危机暂停、休眠、她睡了、出口检查）、发出去、记进聊天记录还在 app.ts（outboxTick → social/outbox.ts 的 drainOutbox）。总是挂（没有男朋友档时那一拍什么都不做）。
// 定时（start: 'built'）和迁移前一样在 App 搭好时开，排在 NOW 之后、她自己想一想的那几样之前。

import type { Module } from '../interpreter/interpreter.ts';

export const OUTBOX_CHECK_MS = 30_000;

export function outboxModule(tick: () => void): Module {
    return { id: 'outbox', schedules: [{ every: OUTBOX_CHECK_MS, run: tick, start: 'built' }] };
}
