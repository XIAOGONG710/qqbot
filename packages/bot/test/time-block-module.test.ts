import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { describeTime } from '../src/language/time-context.ts';
import { timeBlockModule } from '../src/modules/time-block.ts';

// 时间块（ADR 0004 决策 2 / 0105）迁成模块（ADR 0336）：行为基线 35 个场景都有这一行；断网那一句基线走不到，由这里核对开关和条件
describe('时间块模块（ADR 0004 / 0105 / 0336）', () => {
    const at = new Date('2026-11-20T21:00:00+08:00');
    const history = Object.freeze([
        Object.freeze({ role: 'assistant' as const, content: '在呢', time: '2026-11-20T10:00:00.000Z' }),
        Object.freeze({ role: 'user' as const, content: '在吗', time: '2026-11-20T11:10:00.000Z' }),
        Object.freeze({ role: 'user' as const, content: '我刚下课', time: '2026-11-20T11:10:30.000Z' }),
    ]);
    const offlineSince = Date.parse('2026-11-20T11:12:00.000Z');
    const turnOf = (patch: Partial<Turn> = {}, facts: TurnFacts = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, thinking: false, facts, ...patch,
    });
    const run = (t: Turn, lagTail?: boolean) => timeBlockModule(lagTail === undefined ? {} : { lagTail }).contribute!(t) as Piece[];

    test('回他的消息：放 time 槽，写法同 describeTime（时间、距上一条、隔了很久才回）', () => {
        const pieces = run(turnOf());
        assert.deepEqual(pieces, [{ slot: 'time', text: describeTime([...history], at, { initiating: false }) }]);
        assert.match(pieces[0]!.text, /^\[当前时间：2026-11-20 星期五 21:00\]/);
        assert.match(pieces[0]!.text, /距上一条消息/);
        assert.match(pieces[0]!.text, /对方这次的消息是/);
    });

    test('她主动找他：只写上一条消息是谁发的、多久前', () => {
        const [piece] = run(turnOf({ initiate: { note: '', topic: '' } }));
        assert.equal(piece!.text, describeTime([...history], at, { initiating: true }));
        assert.match(piece!.text, /\[上一条消息：.*对方发的/);
        assert.doesNotMatch(piece!.text, /对方这次的消息是/);
    });

    test('断网很久才回：lagTail 开着才加那一句；关着、没有断网起点时不加', () => {
        const withOffline = turnOf({ offlineSince });
        assert.equal(run(withOffline, true)[0]!.text, describeTime([...history], at, { initiating: false, offlineSince }));
        assert.match(run(withOffline, true)[0]!.text, /一直连不上网/);
        assert.doesNotMatch(run(withOffline, false)[0]!.text, /连不上网/);
        assert.doesNotMatch(run(withOffline)[0]!.text, /连不上网/);
        assert.doesNotMatch(run(turnOf(), true)[0]!.text, /连不上网/);
    });

    test('危机、只想一想、被吵醒的轮次照样放（迁移前就不看这些）', () => {
        const always: [string, Turn][] = [
            ['危机', turnOf({}, { crisis: { level: 'high' } as TurnFacts['crisis'] })],
            ['只想一想', turnOf({ thinking: true, initiate: { note: '', topic: '', think: true } })],
            ['被吵醒', turnOf({ woken: true })],
        ];
        for (const [name, t] of always) {
            const pieces = run(t, true);
            assert.equal(pieces.length, 1, name);
            assert.equal(pieces[0]!.slot, 'time', name);
        }
    });

    test('不改聊天记录（冻结的也能算）', () => {
        assert.doesNotThrow(() => run(turnOf({ offlineSince }), true));
        assert.equal(history.length, 3);
    });
});
