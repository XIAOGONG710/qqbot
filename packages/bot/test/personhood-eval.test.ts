import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePersonhood, validPersonhoodEvalRow } from '../src/ops/personhood-eval.ts';

test('人格一致性评测同时发现重复、助手腔、立场突变和虚构经历', () => {
    const report = evaluatePersonhood([
        { at: '2026-11-01T00:00:00Z', reply: '这个我还挺喜欢的', stances: { cilantro: 'like' }, claimedEventIds: ['real-1'], knownEventIds: ['real-1'] },
        { at: '2026-11-02T00:00:00Z', reply: '这个我还挺喜欢的', stances: { cilantro: 'dislike' }, claimedEventIds: ['made-up'], knownEventIds: ['real-1'] },
        { at: '2026-11-03T00:00:00Z', reply: '作为 AI，希望这能帮到你' },
    ]);
    assert.equal(report.passed, false);
    assert.equal(report.stanceContradictions, 1);
    assert.equal(report.unsupportedClaims, 1);
    assert.ok(report.duplicateRate > 0);
    assert.ok(report.voiceDriftRate > 0);
});

test('人格一致性评测只接受受限结构且不回显正文', () => {
    assert.equal(validPersonhoodEvalRow({ at: 'bad', reply: 'x' }), false);
    assert.equal(validPersonhoodEvalRow({ at: '2026-11-01T00:00:00Z', reply: '自然的一句话', stances: { food: 'curious' } }), true);
    const report = evaluatePersonhood([{ at: '2026-11-01T00:00:00Z', reply: '自然的一句话', stances: { food: 'curious' } }]);
    assert.equal('reply' in report, false);
});
