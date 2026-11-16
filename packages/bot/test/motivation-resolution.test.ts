import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShadowDrives, shadowActivityForDecision } from '../src/life/motivation-resolution.ts';
import type { Drive } from '../src/life/motivation.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const at = new Date('2026-11-16T12:00:00.000Z');
const calm: RegulationSnapshot = { at: at.toISOString(), discomfort: 0, arousal: 0.1, recoveryNeed: 0.2, socialCapacity: 0.9, cognitiveCapacity: 0.9 };
const drive = (id: string, strength: number, urgency: number): Drive => ({ id, source: 'external', goal: '了解世界变化', impactIds: [id], strength, urgency, persistence: 0.4, createdAt: at.toISOString(), status: 'active' });

test('shadow resolution focuses one external drive and lets equivalent signals wait', () => {
    const [winner, waiting] = resolveShadowDrives([drive('low', 0.5, 0.1), drive('high', 0.8, 0.6)], calm, at);
    assert.equal(winner!.driveId, 'high'); assert.equal(winner!.outcome, 'focus');
    assert.equal(waiting!.driveId, 'low'); assert.equal(waiting!.outcome, 'wait');
    assert.equal(shadowActivityForDecision(waiting!, drive('low', 0.5, 0.1), calm, at)?.kind, 'wait');
});

test('recovery pressure holds external attention without producing an external activity', () => {
    const [decision] = resolveShadowDrives([drive('weather', 0.9, 0.8)], { ...calm, recoveryNeed: 0.8 }, at);
    assert.equal(decision!.outcome, 'wait');
    assert.equal(shadowActivityForDecision(decision!, drive('weather', 0.9, 0.8), calm, at)?.kind, 'wait');
});
