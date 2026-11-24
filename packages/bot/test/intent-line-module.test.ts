import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { intentLineModule } from '../src/modules/intent-line.ts';

// 这一轮的意图行（ADR 0019 起）迁成模块（ADR 0336）：按 facts.intent / facts.deliberate 现算（深思时只管「怎么答」的那两种不放）。
// 行为基线：意图行 37 个场景、238 处；深思去掉「先直接回答」只有 rich-chat 那一轮。
// （「/亲热」那一行，ADR 0170，2026-11-24 连 intimate 槽一起删了。）

const DIRECT = '[这一轮你想：他问了你一个问题，先直接回答他刚问的，再说别的]';
const ABSTRACT = '[这一轮你想：他在问一个很大、很抽象的问题，挑一个你真有感觉的角度说]';
const PRESS = '[这一轮你想：他在追着要一个答案，别再绕]';

describe('意图行（ADR 0019 / 0151 / 0336）', () => {
    const at = new Date('2026-11-05T12:00:00+08:00');
    const turnOf = (facts: TurnFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '在吗', time: at.toISOString() }], thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => intentLineModule().contribute!(t) as Piece[];

    test('没有意图：什么都不放；空串当没有；深思时「怎么答」的那两种不放', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({ intent: '' })), []);
        assert.deepEqual(run(turnOf({ baseIntent: PRESS })), [], '放的是最终的意图（facts.intent），不是改写之前的 baseIntent');
        assert.deepEqual(run(turnOf({ intent: DIRECT, deliberate: true })), []);
        assert.deepEqual(run(turnOf({ intent: ABSTRACT, deliberate: true })), []);
        assert.deepEqual(run(turnOf({ intent: PRESS, deliberate: true })), [{ slot: 'intent', text: PRESS }]);
        assert.deepEqual(run(turnOf({ intent: DIRECT, deliberate: false })), [{ slot: 'intent', text: DIRECT }]);
    });

    test('同步返回；意图行进「此刻」块', () => {
        const assembled = contributeTurn([intentLineModule()], turnOf({ intent: PRESS }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterHistory, [PRESS]);
    });
});
