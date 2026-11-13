// 主动找他时的说明作为解释器的模块（ADR 0336 第 5 步）：主动消息的计划器（ADR 0011 起）定下这次为什么找他、说什么由头，
// 写在 initiate.note 里；她主动找他的那一轮把它原样放进「此刻」块的 initiateNote 槽（放在最后、离末尾指令最近）。
// note 是空串也照样放一段（迁移前就是这样）。没有开关，不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线里主动找他的轮次核对）。

import type { Module } from '../interpreter/interpreter.ts';

export function initiateNoteModule(): Module {
    return {
        id: 'initiate-note',
        contribute(turn) {
            return turn.initiate ? [{ slot: 'initiateNote', text: turn.initiate.note }] : [];
        },
    };
}
