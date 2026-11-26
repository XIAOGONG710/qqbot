import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { followUpsModule } from '../src/modules/follow-ups.ts';

// 待跟进的定时同步（ADR 0336 第 6 步）：schedules 是 getter，取值时现算；active 为假就一条都不开。
// 文件名带 -module 是因为已有 follow-ups.test.ts 测的是 src/proactive/follow-ups.ts（不同模块，不能覆盖）。
describe('待跟进定时模块（modules/follow-ups.ts）', () => {
    test('模块 id 是 follow-ups', () => {
        assert.equal(followUpsModule(() => {}, () => true, 1).id, 'follow-ups');
    });

    test('active 为真：一条 synced 计时器，间隔照给的，run 就是 sync', () => {
        let syncCalls = 0;
        const sync = () => { syncCalls++; };
        const every = 5 * 60_000;
        const schedules = followUpsModule(sync, () => true, every).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, every);
        assert.equal(schedules[0]!.run, sync);
        assert.equal(schedules[0]!.start, 'synced');
        assert.equal(schedules[0]!.runOnStart, undefined);
        schedules[0]!.run();
        assert.equal(syncCalls, 1);
    });

    test('active 为假：空数组', () => {
        const schedules = followUpsModule(() => {}, () => false, 5 * 60_000).schedules!;
        assert.deepEqual(schedules, []);
    });

    test('schedules 取一次就算一次：active 变了结果跟着变，每次都问 active', () => {
        let active = false;
        let activeCalls = 0;
        const module = followUpsModule(() => {}, () => { activeCalls++; return active; }, 60_000);
        assert.deepEqual(module.schedules, []);
        assert.equal(activeCalls, 1);
        active = true;
        assert.equal(module.schedules!.length, 1);
        assert.equal(activeCalls, 2);
        active = false;
        assert.deepEqual(module.schedules, []);
        assert.equal(activeCalls, 3);
    });

    test('every 是 0：照样给一条，间隔 0', () => {
        const schedules = followUpsModule(() => {}, () => true, 0).schedules!;
        assert.equal(schedules.length, 1);
        assert.equal(schedules[0]!.every, 0);
    });

    test('every 是很大的数：原样保留', () => {
        const every = 30 * 24 * 60 * 60_000;
        const schedules = followUpsModule(() => {}, () => true, every).schedules!;
        assert.equal(schedules[0]!.every, every);
    });
});
