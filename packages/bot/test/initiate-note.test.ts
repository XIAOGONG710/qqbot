import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { initiateNoteModule } from '../src/modules/initiate-note.ts';

// 主动找他的那一轮把计划器写好的 note 原样放进 initiateNote 槽；note 是空串也照放。
const at = new Date('2026-11-20T20:00:00+08:00');
const turnOf = (patch: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [],
    thinking: false,
    facts: {},
    ...patch,
});
const run = (turn: Turn): Piece[] => initiateNoteModule().contribute!(turn) as Piece[];

describe('主动找他的说明模块（modules/initiate-note.ts）', () => {
    test('模块 id 是 initiate-note', () => {
        assert.equal(initiateNoteModule().id, 'initiate-note');
    });

    test('initiate 存在：note 原样放进 initiateNote 槽', () => {
        assert.deepEqual(run(turnOf({ initiate: { note: '想到他今天面试，问问怎么样', topic: '面试' } })), [
            { slot: 'initiateNote', text: '想到他今天面试，问问怎么样' },
        ]);
    });

    test('没有 initiate：空数组', () => {
        assert.deepEqual(run(turnOf()), []);
    });

    test('initiate 在但 note 是空串：照样放一段空的', () => {
        assert.deepEqual(run(turnOf({ initiate: { note: '', topic: '近况' } })), [
            { slot: 'initiateNote', text: '' },
        ]);
    });

    test('超长 note 原样透传', () => {
        const long = '想他了'.repeat(1000);
        assert.deepEqual(run(turnOf({ initiate: { note: long, topic: '近况' } })), [
            { slot: 'initiateNote', text: long },
        ]);
    });

    test('缺 topic 这种字段也照放（源码只读 note）', () => {
        const incomplete = { note: '想他了' } as NonNullable<Turn['initiate']>;
        assert.deepEqual(run(turnOf({ initiate: incomplete })), [{ slot: 'initiateNote', text: '想他了' }]);
    });

    test('危机、只想一想都不影响：照放（源码只认 initiate）', () => {
        const turn = turnOf({
            facts: { crisis: { match: '不想活了', level: 'concern' } },
            thinking: true,
            initiate: { note: '想他了', topic: '近况' },
        });
        assert.deepEqual(run(turn), [{ slot: 'initiateNote', text: '想他了' }]);
    });
});
