import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { ownVoice, useOwnVoice } from '../src/language/own-voice.ts';
import { GROUND_NOTE, GROUND_NOTE_OWN } from '../src/modules/her-now.ts';
import { innerLine, type InnerThought } from '../src/proactive/inner.ts';

// 「她自己的话」实验开关（只给模拟器 A/B）：默认关、关着时说法和原来一样；开着换成「想说就说」
afterEach(() => useOwnVoice(false));

const NOW = Date.parse('2026-11-20T08:00:00.000Z');
const thought: InnerThought = { id: 'th-1', at: '2026-11-20T07:00:00.000Z', text: '有点想他', goes: 'keep' };

describe('她自己的话（own-voice）', () => {
    test('默认关：念头那行还是「接不上就别硬说」', () => {
        assert.equal(ownVoice(), false);
        const line = innerLine([thought], NOW)!;
        assert.match(line, /接不上就别硬说/);
        assert.match(line, /「有点想他」/);
    });

    test('开着：念头那行叫她想说就说，不再叫她别硬说；关回去恢复原样', () => {
        const before = innerLine([thought], NOW);
        useOwnVoice(true);
        const line = innerLine([thought], NOW)!;
        assert.match(line, /想说就说出来，不用等他问/);
        assert.doesNotMatch(line, /别硬说/);
        assert.match(line, /「有点想他」/);
        useOwnVoice(false);
        assert.equal(innerLine([thought], NOW), before);
    });

    test('状态那行的另一种说法：不再写「没人问就别主动说」', () => {
        assert.match(GROUND_NOTE, /没人问就别主动说/);
        assert.doesNotMatch(GROUND_NOTE_OWN, /别主动说/);
        assert.match(GROUND_NOTE_OWN, /不用等他问/);
    });
});
