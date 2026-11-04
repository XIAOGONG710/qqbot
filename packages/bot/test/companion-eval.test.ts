import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCompanion } from '../src/ops/companion-eval.ts';

test('长期拟人评测只返回匿名指标，能识别重复、内部数值和助手套话', () => {
    const report = evaluateCompanion([
        { time: '2026-11-01T00:00:00Z', role: 'user', content: '在吗' },
        { time: '2026-11-01T00:00:01Z', role: 'assistant', content: '我在呢，怎么啦' },
        { time: '2026-11-02T00:00:00Z', role: 'assistant', content: '我在呢，怎么啦。' },
        { time: '2026-11-03T00:00:00Z', role: 'assistant', content: '我的亲密值=88' },
        { time: '2026-11-04T00:00:00Z', role: 'assistant', content: '作为一个AI，希望这能帮到你' },
    ]);
    assert.equal(report.assistantMessages, 4);
    assert.equal(report.duplicateRate, 0.25);
    assert.equal(report.internalLeakRate, 0.25);
    assert.equal(report.assistantMetaRate, 0.25);
    assert.doesNotMatch(JSON.stringify(report), /怎么啦|亲密值/);
});
