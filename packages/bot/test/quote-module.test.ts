import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { quoteModule } from '../src/modules/quote.ts';
import { describeQuote } from '../src/social/quote-reply.ts';

// 引用回复（ADR 0136）迁成模块（ADR 0336）：行为基线的 quote 场景管引用 / 不引用、同学；挡引用的那几样由这里逐个核对
describe('引用回复模块（ADR 0136 / 0336）', () => {
    const at = new Date('2026-11-20T20:00:00+08:00');
    const stored: StoredMessage[] = [
        { time: '2026-11-20T11:50:00.000Z', role: 'assistant', content: '在呢', messageId: 90 },
        { time: '2026-11-20T12:00:00.000Z', role: 'user', content: '你周末有空吗？', messageId: 101 },
        { time: '2026-11-20T12:00:01.000Z', role: 'user', content: '我在想去哪玩', messageId: 102 },
    ];
    const turnOf = (facts: TurnFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [], thinking: false, facts, ...patch,
    });
    // share 1：一定抽中，只看条件
    const run = (t: Turn) => quoteModule({ history: () => stored, share: 1, log: () => {} }).contribute!(t) as Piece[];

    test('抽中了：放 quote 槽，引用的那条写回 facts.quote', () => {
        const t = turnOf();
        assert.deepEqual(run(t), [{ slot: 'quote', text: describeQuote({ messageId: 101, text: '你周末有空吗？' }) }]);
        assert.deepEqual(t.facts.quote, { messageId: 101, text: '你周末有空吗？' });
    });

    test('主动找他、只想一想、危机、只发表情、照片、先接住他的情绪：都不引用', () => {
        const blocked: [string, Turn][] = [
            ['主动找他', turnOf({}, { initiate: { note: '', topic: '' } })],
            ['只想一想', turnOf({}, { thinking: true })],
            ['危机', turnOf({ crisis: { level: 'high' } as TurnFacts['crisis'] })],
            ['只发表情', turnOf({ stickerOnly: true })],
            ['照片', turnOf({ photo: 'cat' })],
            ['先接住情绪', turnOf({ baseIntent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' })],
        ];
        for (const [name, t] of blocked) {
            assert.deepEqual(run(t), [], name);
            assert.equal(t.facts.quote, undefined, name);
        }
    });
});
