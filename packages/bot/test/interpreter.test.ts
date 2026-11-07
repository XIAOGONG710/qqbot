import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createInterpreter, reviewTurn, runTurn, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { AFTER_HISTORY_SLOTS, AFTER_MAIN_SLOTS, ALL_SLOTS, assemblePrompt, NOW_SLOTS, type Piece } from '../src/interpreter/slots.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';

const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'classmate' }, at: new Date(0), history: [], thinking: false, facts: {} };
const message = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 2, user_id: 1, message_id: 3, time: 0, message: '在吗', raw_message: '在吗', sender: { user_id: 1 } } as MessageEvent;

describe('提示词槽位表（ADR 0263）', () => {
    test('每个槽名只出现一次', () => {
        assert.equal(new Set(ALL_SLOTS).size, ALL_SLOTS.length);
        assert.equal(ALL_SLOTS.length, AFTER_MAIN_SLOTS.length + AFTER_HISTORY_SLOTS.length + NOW_SLOTS.length);
    });

    test('按表排序：消息槽各一条，「此刻」行拼成最后一条；同槽按给出的顺序', () => {
        const pieces: Piece[] = [
            { slot: 'intent', text: '[意图]' }, { slot: 'time', text: '[时间]' }, { slot: 'people', text: '人1' }, { slot: 'relationship', text: '关系' },
            { slot: 'summary', text: '要点' }, { slot: 'people', text: '人2' }, { slot: 'mood', text: '[心情]' },
        ];
        assert.deepEqual(assemblePrompt(pieces), { afterMain: ['关系'], afterHistory: ['要点', '人1', '人2', '[时间]\n[心情]\n[意图]'] });
        assert.deepEqual(assemblePrompt([]), { afterMain: [], afterHistory: [] });
        assert.throws(() => assemblePrompt([{ slot: 'nope' as never, text: 'x' }]), /没有这个提示词槽/);
    });
});

describe('解释器骨架（ADR 0263）', () => {
    test('一轮回复：先全部 assess 再全部 contribute；都同步时同步返回', () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: () => { order.push('a.assess'); }, contribute: () => { order.push('a.contribute'); return [{ slot: 'intent', text: 'A' }]; } };
        const b: Module = { id: 'b', assess: () => { order.push('b.assess'); }, contribute: () => { order.push('b.contribute'); return [{ slot: 'time', text: 'B' }]; } };
        const result = runTurn([a, b], turn);
        assert.ok(!(result instanceof Promise));
        assert.deepEqual(result, { afterMain: [], afterHistory: ['B\nA'] });
        assert.deepEqual(order, ['a.assess', 'b.assess', 'a.contribute', 'b.contribute']);
    });

    test('有异步钩子时整轮变成 promise，顺序不变', async () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: async () => { await null; order.push('a'); } };
        const b: Module = { id: 'b', assess: () => { order.push('b'); }, contribute: async () => [{ slot: 'time', text: 'T' }] };
        const result = runTurn([a, b], turn);
        assert.ok(result instanceof Promise);
        assert.deepEqual(await result, { afterMain: [], afterHistory: ['T'] });
        assert.deepEqual(order, ['a', 'b']);
    });

    test('review 按模块顺序逐个改草稿', async () => {
        const modules: Module[] = [{ id: 'x', review: draft => `${draft}1` }, { id: 'y' }, { id: 'z', review: async draft => `${draft}2` }];
        assert.equal(reviewTurn([modules[0]!, modules[1]!], '稿', turn), '稿1');
        assert.equal(await reviewTurn(modules, '稿', turn), '稿12');
    });

    test('分发：按注册顺序；只有一个返回 promise 时原样返回它；没有处理的事件返回 undefined', async () => {
        const seen: string[] = [];
        const pending = Promise.resolve();
        const interpreter = createInterpreter({ modules: [
            { id: 'one', on: { message: () => { seen.push('one'); } } },
            { id: 'two', on: { message: () => { seen.push('two'); }, connected: () => pending } },
            { id: 'turn', contribute: () => [] },
        ] });
        assert.equal(interpreter.dispatch({ kind: 'message', event: message }), undefined);
        assert.deepEqual(seen, ['one', 'two']);
        assert.equal(interpreter.dispatch({ kind: 'connected', selfId: 2 }), pending);
        assert.equal(interpreter.dispatch({ kind: 'recall', event: { post_type: 'notice', notice_type: 'friend_recall', self_id: 2, user_id: 1, message_id: 3 } }), undefined);
        assert.deepEqual(interpreter.turnModules.map(m => m.id), ['turn']);
    });

    test('处理函数同步抛错照样抛；模块 id 不能重复', () => {
        const interpreter = createInterpreter({ modules: [{ id: 'bad', on: { message: () => { throw new Error('坏了'); } } }] });
        assert.throws(() => interpreter.dispatch({ kind: 'message', event: message }), /坏了/);
        assert.throws(() => createInterpreter({ modules: [{ id: 'a' }, { id: 'a' }] }), /重复/);
    });
});
