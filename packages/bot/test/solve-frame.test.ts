import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { SOLVE_FRAME_NOTE, solveFrameModule } from '../src/modules/solve-frame.ts';

// 「做题式」写法（ADR 0146）：只有模拟器的 --frame solve 用；主动找他、危机的轮次不放。
const at = new Date('2026-11-20T20:00:00+08:00');
const turnOf = (patch: Partial<Turn> = {}): Turn => ({
    contact: { qq: 1, name: '阿明', tier: 'boyfriend' },
    at,
    history: [],
    thinking: false,
    facts: {},
    ...patch,
});
const run = (turn: Turn): Piece[] => solveFrameModule().contribute!(turn) as Piece[];

describe('做题式写法模块（modules/solve-frame.ts）', () => {
    test('模块 id 是 solve-frame', () => {
        assert.equal(solveFrameModule().id, 'solve-frame');
    });

    test('普通轮次：放 solveFrame 槽，文字就是 SOLVE_FRAME_NOTE', () => {
        assert.deepEqual(run(turnOf()), [{ slot: 'solveFrame', text: SOLVE_FRAME_NOTE }]);
    });

    test('SOLVE_FRAME_NOTE 的内容：不演、只推断最可能发出去的几条、每条一行', () => {
        assert.match(SOLVE_FRAME_NOTE, /不要去想怎么显得像真人/);
        assert.match(SOLVE_FRAME_NOTE, /也不要演/);
        assert.match(SOLVE_FRAME_NOTE, /最可能真的发出去的那几条消息/);
        assert.match(SOLVE_FRAME_NOTE, /最普通、最不费力、最贴着语境的那一版/);
        assert.match(SOLVE_FRAME_NOTE, /不是最精彩、最周全的那一版/);
        assert.match(SOLVE_FRAME_NOTE, /只输出这几条消息，每条一行/);
    });

    test('主动找他：不放', () => {
        assert.deepEqual(run(turnOf({ initiate: { note: '想他了', topic: '近况' } })), []);
    });

    test('危机回合：不放', () => {
        assert.deepEqual(run(turnOf({ facts: { crisis: { match: '不想活了', level: 'concern' } } })), []);
    });

    test('主动找他且危机：不放', () => {
        assert.deepEqual(run(turnOf({
            facts: { crisis: { match: '不想活了', level: 'concern' } },
            initiate: { note: '想他了', topic: '近况' },
        })), []);
    });

    test('只想一想（thinking）：照放（源码只拦 initiate / crisis）', () => {
        assert.deepEqual(run(turnOf({ thinking: true })), [{ slot: 'solveFrame', text: SOLVE_FRAME_NOTE }]);
    });

    test('空聊天记录、没有卡：照放', () => {
        assert.deepEqual(run(turnOf({ history: [], card: undefined })), [{ slot: 'solveFrame', text: SOLVE_FRAME_NOTE }]);
    });
});
