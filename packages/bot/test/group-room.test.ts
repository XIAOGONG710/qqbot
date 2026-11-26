import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GroupMessageEvent } from '../src/platform/onebot.ts';
import { GROUP_OWN } from '../src/social/group-self.ts';
import type { GroupRoom } from '../src/social/group-room.ts';
import { groupRoomModule } from '../src/modules/group-room.ts';

// 群聊入口（ADR 0336 第 6 步）：群消息交给 room().receive；own / agency 任一为真才挂一条 10 分钟的 tick。
// room 是取的函数，构造时不取；事件来了、定时器跑了才现取。
const TICK_MS = GROUP_OWN.tickMs;

const event: GroupMessageEvent = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 999,
    user_id: 10001,
    group_id: 20001,
    message_id: 1,
    time: 1,
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw_message: '在吗',
    sender: { user_id: 10001, nickname: '阿明' },
};

const fixture = () => {
    const seen: GroupMessageEvent[] = [];
    let ticks = 0;
    const room: GroupRoom = {
        receive: e => { seen.push(e); },
        syncNames: async () => {},
        tick: async () => { ticks++; },
    };
    return { room, seen, get ticks() { return ticks; } };
};

describe('群聊入口模块（modules/group-room.ts）', () => {
    test('模块 id 是 group-room', () => {
        const f = fixture();
        assert.equal(groupRoomModule(() => f.room).id, 'group-room');
    });

    test('群消息事件：交给 room().receive，事件原样；构造时不取 room，来事件时才取', () => {
        const f = fixture();
        let roomCalls = 0;
        const module = groupRoomModule(() => { roomCalls++; return f.room; });
        assert.equal(roomCalls, 0);
        module.on!.group!({ kind: 'group', event });
        assert.equal(roomCalls, 1);
        assert.deepEqual(f.seen, [event]);
        module.on!.group!({ kind: 'group', event });
        assert.equal(roomCalls, 2);
        assert.equal(f.seen.length, 2);
        assert.equal(f.seen[1], event);
    });

    test('默认 options：没有 schedules', () => {
        const f = fixture();
        assert.equal(groupRoomModule(() => f.room).schedules, undefined);
    });

    test('own、agency 都是 false：没有 schedules', () => {
        const f = fixture();
        assert.equal(groupRoomModule(() => f.room, { own: false, agency: false }).schedules, undefined);
    });

    test('own 为真：一条 10 分钟计时器，run 现取 room 并触发 tick，返回 undefined', () => {
        const f = fixture();
        let roomCalls = 0;
        const module = groupRoomModule(() => { roomCalls++; return f.room; }, { own: true });
        assert.equal(roomCalls, 0, '构造时不取 room');
        const schedules = module.schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(TICK_MS, 10 * 60_000);
        assert.equal(schedules[0]!.every, TICK_MS);
        assert.equal(schedules[0]!.start, undefined);
        assert.equal(schedules[0]!.runOnStart, undefined);
        assert.equal(schedules[0]!.run(), undefined);
        assert.equal(roomCalls, 1);
        assert.equal(f.ticks, 1);
    });

    test('agency 为真：同样挂一条计时器', () => {
        const f = fixture();
        const module = groupRoomModule(() => f.room, { agency: true });
        assert.equal(module.schedules!.length, 1);
        assert.equal(module.schedules![0]!.every, TICK_MS);
        module.schedules![0]!.run();
        assert.equal(f.ticks, 1);
    });

    test('own 和 agency 都为真：仍然只有一条计时器', () => {
        const f = fixture();
        const module = groupRoomModule(() => f.room, { own: true, agency: true });
        assert.equal(module.schedules!.length, 1);
        module.schedules![0]!.run();
        module.schedules![0]!.run();
        assert.equal(f.ticks, 2);
    });

    test('选项关闭时挂不上、打开时挂得上：两个方向各测一次', () => {
        const f = fixture();
        assert.equal(groupRoomModule(() => f.room, { own: false, agency: false }).schedules, undefined);
        assert.equal(groupRoomModule(() => f.room, { own: true, agency: false }).schedules!.length, 1);
        assert.equal(groupRoomModule(() => f.room, { own: false, agency: true }).schedules!.length, 1);
    });

    test('只挂群消息处理器，没有 contribute', () => {
        const f = fixture();
        const module = groupRoomModule(() => f.room);
        assert.equal(module.contribute, undefined);
        assert.equal(typeof module.on!.group, 'function');
    });
});
