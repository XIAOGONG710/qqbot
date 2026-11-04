import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCompanionWindows, type CompanionEvalRow } from '../src/ops/companion-eval.ts';

const rows = (prefix: string, meta = false): CompanionEvalRow[] => Array.from({ length: 25 }, (_, index) => ({
    time: new Date(Date.UTC(2026, 10, 4, 0, index)).toISOString(),
    role: 'assistant' as const,
    content: meta ? '作为一个AI，希望这能帮到你' : `${prefix}${index}，等会儿再说`,
}));

test('长期拟人回归比较两个窗口并只报告比例', () => {
    const report = compareCompanionWindows(rows('旧'), rows('新', true));
    assert.equal(report.passed, false);
    assert.ok(report.regressions.some(item => item.kind === 'rate' && item.metric === 'assistantMetaRate'));
    assert.doesNotMatch(JSON.stringify(report), /希望这能帮到你|等会儿再说/);
});

test('样本不足时失败关闭', () => {
    const report = compareCompanionWindows(rows('旧').slice(0, 2), rows('新').slice(0, 2));
    assert.equal(report.passed, false);
});
