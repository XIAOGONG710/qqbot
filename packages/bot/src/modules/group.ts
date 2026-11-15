// 群里最近的事作为解释器的模块（2026-11-14）：私聊里他问「群里刚才说什么了」，她答得上。
// 取的那一下（options.groupRecent，读群记录）留在联系人流水线里，结果写进 turn.facts.groupEcho；
// 这里只照原样放进 group 槽（紧跟桌面上的她之后）。
import type { Module } from '../interpreter/interpreter.ts';

export function groupModule(): Module {
    return {
        id: 'group',
        contribute(turn) {
            const echo = turn.facts.groupEcho;
            return echo ? [{ slot: 'group' as const, text: echo }] : [];
        },
    };
}
