import type { Module } from '../interpreter/interpreter.ts';
import type { GroupRoom } from '../social/group-room.ts';
import { GROUP_OWN } from '../social/group-self.ts';

// 群聊（ADR 0210）的入口（ADR 0336 第 6 步）：解释器把群消息交给群里那一摊（social/group-room.ts）。
// 挂在「旧逻辑」那一个后面、其余模块前面——原来群消息就是由「旧逻辑」最先转过去的。
// App 里解释器建得比群聊那一摊早，所以给的是取它的函数，事件来了才取（事件都在 App 搭好之后才来）。
// 群里她也有自己（ADR 0341，groupOwn 不是 off）：连上之后每 10 分钟看一眼，哪个群冷场了、她那边有没有事（关着时不开计时器）。
export function groupRoomModule(room: () => GroupRoom, options: { own?: boolean } = {}): Module {
    return {
        id: 'group-room',
        on: { group: ({ event }) => { room().receive(event); } },
        ...(options.own ? { schedules: [{ every: GROUP_OWN.tickMs, run: () => { void room().tick(); } }] } : {}),
    };
}
