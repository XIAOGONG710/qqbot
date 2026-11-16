import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionOpportunity } from '../src/life/expression-opportunity.ts';
import type { Drive } from '../src/life/motivation.ts';
import type { ShadowDriveDecision } from '../src/life/motivation-resolution.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const drive: Drive = { id: 'd1', source: 'external', goal: '了解环境', impactIds: ['i1'], strength: 0.9, urgency: 0.8, persistence: 0.4, createdAt: '2026-11-16T12:00:00.000Z', status: 'active' };
const decision: ShadowDriveDecision = { id: 'decision:d1', driveId: 'd1', outcome: 'focus', score: 0.8, decidedAt: '2026-11-16T12:00:00.000Z', reason: '当前可保留这一项内部关注' };
const calm: RegulationSnapshot = { at: decision.decidedAt, discomfort: 0, arousal: 0.1, recoveryNeed: 0.2, socialCapacity: 0.8, cognitiveCapacity: 0.8 };

test('expression opportunity is permission to ask her, never an instruction to speak', () => {
    assert.deepEqual(expressionOpportunity(decision, drive, calm), { driveId: 'd1', eligible: true, blocks: [], reason: '可交给她当下判断是否开口' });
});

test('low mood, discomfort, recovery, private matters and diary sources are hard expression blocks', () => {
    const opportunity = expressionOpportunity(decision, drive, { ...calm, discomfort: 0.5, recoveryNeed: 0.8 }, { lowMood: true, privateSource: true, diarySource: true });
    assert.equal(opportunity.eligible, false);
    assert.deepEqual(opportunity.blocks, ['low_mood', 'body_discomfort', 'recovery', 'private_source', 'diary_source']);
    assert.equal(expressionOpportunity({ ...decision, outcome: 'wait' }, drive, calm).eligible, false);
});
