// 时间块作为解释器的模块（ADR 0336 第 5 步）：ADR 0004 决策 2——每一轮「此刻」块的第一行是当前时间，下面是距上一条消息多久、
// 他这次的消息是不是隔了很久才回（对方连发时按这一组的第一条算）；她主动找他时只写上一条消息是谁发的、多久前。
// 回复一直失败、断网很久才回（ADR 0105，配置 lagTail）：再加一句断网的事实，可以顺口说「刚才网断了」。放进 time 槽。
// 没有别的开关，每一轮都放（危机、只想一想的轮次也放，迁移前就不看这些）。describeTime（language/time-context.ts）是纯函数，一个字没改；
// 读的聊天记录、此刻、断网起点就是构造 turn 时放进去的同一份，拼段落之前没人改它们，所以挪到 contribute 时算结果一样。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 35 个场景都有这一行）。

import type { Module } from '../interpreter/interpreter.ts';
import { describeTime } from '../language/time-context.ts';

export interface TimeBlockModuleOptions {
    /** 回复延迟的长尾（ADR 0105，配置 lagTail）：开着才写断网的那一句 */
    lagTail?: boolean;
}

export function timeBlockModule(options: TimeBlockModuleOptions = {}): Module {
    return {
        id: 'time-block',
        contribute(turn) {
            const text = describeTime([...turn.history], turn.at, {
                initiating: Boolean(turn.initiate),
                ...(options.lagTail && turn.offlineSince !== undefined ? { offlineSince: turn.offlineSince } : {}),
            });
            return [{ slot: 'time', text }];
        },
    };
}
