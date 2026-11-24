import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { recallsModule, type RecallDeps } from '../src/modules/recalls.ts';
import type { Contact } from '../src/platform/config.ts';
import type { PendingIncoming } from '../src/memory/history.ts';
import type { RecallEvent } from '../src/platform/onebot.ts';

// 撤回模块（modules/recalls.ts）：只测模块自己的分支，聊天记录用假的（真记录的撤回见 recall.test.ts）。
const him: Contact = { qq: 1001, name: '他', tier: 'boyfriend' };
const event = (userId: number, messageId: number): RecallEvent => ({ post_type: 'notice', notice_type: 'friend_recall', self_id: 9, user_id: userId, message_id: messageId });

function harness(over: { recalls?: boolean; stopped?: boolean; hasMemory?: boolean; recall?: (qq: number, id: number, keep: (content: string) => boolean) => boolean; pending?: PendingIncoming[]; observeThrows?: boolean } = {}) {
    const calls: string[] = [];
    const failures: unknown[] = [];
    const logs: string[] = [];
    let revision = 0;
    let keepSeen: ((content: string) => boolean) | undefined;
    const deps: RecallDeps = {
        config: { recalls: over.recalls ?? true, contacts: [him] },
        stopped: () => over.stopped ?? false,
        chatHistory: {
            recallRevision: () => revision,
            recall: (qq, id, keep = () => false) => { keepSeen = keep; calls.push(`recall:${qq}:${id}`); return over.recall ? over.recall(qq, id, keep) : true; },
            pendingIncoming: () => over.pending ?? [],
        },
        hasMemory: over.hasMemory ?? true,
        observeRecalledMemory: contact => { calls.push(`observe:${contact.qq}`); if (over.observeThrows) throw new Error('barrier'); },
        syncRecalledMemory: qq => { calls.push(`sync:${qq}`); },
        incomingFailure: error => { failures.push(error); },
        log: message => { logs.push(message); },
    };
    const module = recallsModule(() => deps);
    const fire = (e: RecallEvent) => module.on!.recall!({ kind: 'recall', event: e });
    return { module, fire, calls, failures, logs, bump: () => { revision++; }, keep: () => keepSeen };
}

describe('撤回模块', () => {
    test('模块 id 是 recalls，只挂 recall 事件', () => {
        const { module } = harness();
        assert.equal(module.id, 'recalls');
        assert.deepEqual(Object.keys(module.on ?? {}), ['recall']);
    });

    test('名单里的人撤回还没回的一条：记撤回、先让记忆知道（屏障）、再同步，日志说「还没回」', () => {
        const h = harness();
        h.fire(event(him.qq, 55));
        assert.deepEqual(h.calls, ['recall:1001:55', 'observe:1001', 'sync:1001']);
        assert.deepEqual(h.logs, ['[1001] 他撤回了一条还没回的消息，记成「撤回了一条消息」']);
        assert.deepEqual(h.failures, []);
    });

    test('撤回的是待处理的入站：日志说已保存撤回意图（只认同一个 messageId 且 withdrawn 的）', () => {
        const pending = (messageId: number, withdrawn: boolean): PendingIncoming => ({ id: `inc-${messageId}`, withdrawn, source: { time: '2026-11-24T00:00:00.000Z', role: 'user', messageId }, message: 'x' });
        const h = harness({ pending: [pending(54, true), pending(55, true)] });
        h.fire(event(him.qq, 55));
        assert.deepEqual(h.logs, ['[1001] 他撤回了一条待处理消息，已保存撤回意图']);
        const other = harness({ pending: [pending(55, false), pending(56, true)] });
        other.fire(event(him.qq, 55));
        assert.match(other.logs[0]!, /还没回的消息/, '没标 withdrawn 的、别的 id 的不算待处理撤回');
    });

    test('危机内容撤回了也要留着：传给聊天记录的 keep 认得想伤害自己的话，普通话不留', () => {
        const h = harness();
        h.fire(event(him.qq, 1));
        const keep = h.keep()!;
        assert.equal(keep('我不想活了'), true);
        assert.equal(keep('今天吃了面条'), false);
    });

    test('聊天记录说这条不算撤回（回过了、不认识）：不碰记忆屏障、不记日志，但仍同步一次', () => {
        const h = harness({ recall: () => false });
        h.fire(event(him.qq, 2));
        assert.deepEqual(h.calls, ['recall:1001:2', 'sync:1001']);
        assert.deepEqual(h.logs, []);
    });

    test('不处理：撤回开关关着、已经停了、不在名单里的人（陌生人的撤回不碰任何记录）', () => {
        for (const h of [harness({ recalls: false }), harness({ stopped: true })]) {
            h.fire(event(him.qq, 3));
            assert.deepEqual(h.calls, []);
        }
        const stranger = harness();
        stranger.fire(event(4242, 3));
        assert.deepEqual(stranger.calls, []);
        assert.deepEqual(stranger.logs, []);
    });

    test('事件来了才取依赖：模块建好时不取', () => {
        let asked = 0;
        const module = recallsModule(() => { asked++; throw new Error('还没搭好'); });
        assert.equal(asked, 0);
        assert.throws(() => module.on!.recall!({ kind: 'recall', event: event(him.qq, 1) }), /还没搭好/);
        assert.equal(asked, 1);
    });

    test('出错：记录没变（单纯读错）就不碰记忆，只报 incomingFailure；不同步旧正文', () => {
        const boom = new Error('读不了');
        const h = harness({ recall: () => { throw boom; } });
        h.fire(event(him.qq, 7));
        assert.deepEqual(h.calls, ['recall:1001:7'], '没有 observe、没有 sync');
        assert.deepEqual(h.failures, [boom]);
    });

    test('出错：记录已经变了（RAM 接受了撤回）且开着记忆，补一次屏障再报错', () => {
        const boom = new Error('写盘失败');
        let bump!: () => void;
        const h = harness({ recall: () => { bump(); throw boom; } });
        bump = h.bump;
        h.fire(event(him.qq, 8));
        assert.deepEqual(h.calls, ['recall:1001:8', 'observe:1001'], '补了屏障，但不同步');
        assert.deepEqual(h.failures, [boom]);
    });

    test('出错：记录变了但没开记忆，不碰记忆；补的屏障自己也失败时两个错都报', () => {
        const boom = new Error('写盘失败');
        let bump!: () => void;
        const noMemory = harness({ hasMemory: false, recall: () => { bump(); throw boom; } });
        bump = noMemory.bump;
        noMemory.fire(event(him.qq, 9));
        assert.deepEqual(noMemory.calls, ['recall:1001:9']);
        assert.deepEqual(noMemory.failures, [boom]);

        const both = harness({ observeThrows: true, recall: () => { bump(); throw boom; } });
        bump = both.bump;
        both.fire(event(him.qq, 9));
        assert.equal(both.failures.length, 2);
        assert.match(String(both.failures[0]), /barrier/);
        assert.equal(both.failures[1], boom);
    });

    test('屏障在正常路径抛错（读不到聊天记录）：不同步，交给 incomingFailure', () => {
        const h = harness({ observeThrows: true, hasMemory: false });
        h.fire(event(him.qq, 10));
        assert.deepEqual(h.calls, ['recall:1001:10', 'observe:1001']);
        assert.equal(h.failures.length, 1);
        assert.deepEqual(h.logs, []);
    });
});
