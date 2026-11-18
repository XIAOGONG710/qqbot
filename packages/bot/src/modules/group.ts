// 私聊明确问一个群的公开日程时，放入针对该群的召回结果。
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
