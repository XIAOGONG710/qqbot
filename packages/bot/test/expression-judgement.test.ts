import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionJudgementPrompt, parseExpressionJudgement } from '../src/life/expression-judgement.ts';

test('expression judgement gives her speak, wait and decline rather than an imperative', () => {
    const prompt = expressionJudgementPrompt({ driveId: 'd', eligible: true, blocks: [], reason: '可交给她当下判断是否开口' })!;
    assert.match(prompt, /"speak"\|"wait"\|"decline"/);
    assert.match(prompt, /没有义务开口/);
    assert.deepEqual(parseExpressionJudgement('{"choice":"wait","reason":"晚点再说"}'), { choice: 'wait', reason: '晚点再说' });
    assert.equal(parseExpressionJudgement('{"choice":"send"}'), undefined);
    assert.equal(expressionJudgementPrompt({ driveId: 'd', eligible: false, blocks: ['low_mood'], reason: '当前不应推动她开口' }), undefined);
});
