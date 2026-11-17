import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proactiveAgency } from '../src/proactive/agency.ts';
import type { Candidate } from '../src/proactive/proactive.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const at = new Date('2026-11-17T12:00:00.000Z');
const calm: RegulationSnapshot = { at: at.toISOString(), discomfort: 0, arousal: 0.1, recoveryNeed: 0.2, socialCapacity: 0.9, cognitiveCapacity: 0.9 };
const candidate = (occasion: Candidate['occasion'], extra: Partial<Candidate> = {}): Candidate => ({
    id: `2026-11-17:${occasion}`, occasion, day: '2026-11-17', at: at.getTime(), reason: '合成测试', ...extra,
});

test('class ending and silence remain clock checks, not motives', () => {
    for (const occasion of ['after_class', 'quiet', 'share', 'ask', 'invite'] as const) {
        const result = proactiveAgency(candidate(occasion), calm, at);
        assert.equal(result.eligible, false);
        assert.equal(result.drive, undefined);
    }
});

test('retained rhythms, inner thoughts and world facts enter the same auditable drive decision', () => {
    for (const occasion of ['morning', 'bedtime', 'inner', 'weather'] as const) {
        const result = proactiveAgency(candidate(occasion), calm, at);
        assert.equal(result.eligible, true, occasion);
        assert.equal(result.decision?.outcome, 'focus');
        assert.equal(result.opportunity?.eligible, true);
    }
});

test('one unanswered proactive attempt makes ordinary motives wait', () => {
    for (const occasion of ['reach', 'morning', 'inner'] as const) {
        const result = proactiveAgency(candidate(occasion, occasion === 'reach' ? { reach: { count: 1 } } : {}), calm, at, { unansweredCount: 1 });
        assert.equal(result.eligible, false, occasion);
        assert.match(result.reason, /主动过一次.*先等/);
    }
    assert.equal(proactiveAgency(candidate('bedtime'), calm, at, { unansweredCount: 1 }).eligible, true);
});

test('bodily news is an internal need and may be expressed while ordinary outside context waits during discomfort', () => {
    const strained: RegulationSnapshot = { ...calm, discomfort: 0.6, recoveryNeed: 0.75 };
    const unwell = proactiveAgency(candidate('news', { news: { id: 'u1', kind: 'unwell', day: '2026-11-17', at: at.getTime(), what: '合成不适' } }), strained, at);
    const weather = proactiveAgency(candidate('weather'), strained, at);
    assert.equal(unwell.drive?.source, 'internal');
    assert.equal(unwell.eligible, true);
    assert.equal(weather.eligible, false);
});
