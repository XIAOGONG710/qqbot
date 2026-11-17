import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activitiesFromInnerChoice, proactiveAgency } from '../src/proactive/agency.ts';
import type { Candidate } from '../src/proactive/proactive.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const at = new Date('2026-11-17T12:00:00.000Z');
const calm: RegulationSnapshot = { at: at.toISOString(), discomfort: 0, arousal: 0.1, recoveryNeed: 0.2, socialCapacity: 0.9, cognitiveCapacity: 0.9 };
const candidate = (occasion: Candidate['occasion'], extra: Partial<Candidate> = {}): Candidate => ({
    id: `2026-11-17:${occasion}`, occasion, day: '2026-11-17', at: at.getTime(), reason: '合成测试', ...extra,
});

test('clock checks including greetings and unanswered nudges do not manufacture motives', () => {
    for (const occasion of ['morning', 'bedtime', 'after_class', 'quiet', 'reach', 'share', 'ask', 'invite'] as const) {
        const result = proactiveAgency(candidate(occasion), calm, at);
        assert.equal(result.eligible, false);
        assert.equal(result.drive, undefined);
    }
});

test('a chosen inner thought and observed life facts enter an auditable activity decision', () => {
    for (const signal of [
        candidate('inner', { inner: { id: 'th-1', text: '有件事想告诉他', goes: 'tell' } }),
        candidate('weather'),
        candidate('news', { news: { id: 'small-1', kind: 'small_thing', day: '2026-11-17', at: at.getTime(), what: '合成小事' } }),
    ]) {
        const result = proactiveAgency(signal, calm, at);
        assert.equal(result.eligible, true, signal.occasion);
        assert.equal(result.decision?.outcome, 'focus');
        assert.equal(result.opportunity?.eligible, true);
        assert.equal(result.activity?.kind, 'message');
        assert.ok(result.drive?.stateKeys?.length || result.drive?.eventIds?.length);
    }
});

test('one unanswered proactive attempt makes ordinary motives wait', () => {
    for (const occasion of ['reach', 'morning', 'inner'] as const) {
        const result = proactiveAgency(candidate(occasion, occasion === 'reach' ? { reach: { count: 1 } } : {}), calm, at, { unansweredCount: 1 });
        assert.equal(result.eligible, false, occasion);
        assert.match(result.reason, /主动过一次.*先等/);
    }
    assert.equal(proactiveAgency(candidate('bedtime'), calm, at, { unansweredCount: 1 }).eligible, false);
    const reschedule = candidate('reschedule', { reschedule: { id: 'p-1', day: '2026-11-17', at: at.getTime(), start: at.getTime() + 3_600_000, what: '合成约定', time: '21:00', obstacle: { kind: 'unwell', id: 'o-1', text: '合成不适' } } });
    assert.equal(proactiveAgency(reschedule, calm, at, { unansweredCount: 1 }).eligible, true);
    assert.equal(proactiveAgency(reschedule, { ...calm, discomfort: 0.6, recoveryNeed: 0.75 }, at, { unansweredCount: 1 }).eligible, true);
});

test('bodily news selects self care before seeking attention; outside context waits during discomfort', () => {
    const strained: RegulationSnapshot = { ...calm, discomfort: 0.6, recoveryNeed: 0.75 };
    const unwell = proactiveAgency(candidate('news', { news: { id: 'u1', kind: 'unwell', day: '2026-11-17', at: at.getTime(), what: '合成不适' } }), strained, at);
    const weather = proactiveAgency(candidate('weather'), strained, at);
    assert.equal(unwell.drive?.source, 'internal');
    assert.equal(unwell.activity?.kind, 'self_care');
    assert.equal(unwell.eligible, false);
    assert.equal(weather.eligible, false);
});

test('her explicit inner choice yields research, plan adjustment or remembering without creating a message', () => {
    const kept = { id: 'th-42', at: at.toISOString(), text: '想自己琢磨一下', goes: 'keep' as const };
    const alone = activitiesFromInnerChoice(kept, at)!;
    assert.deepEqual(alone.activities.map(item => item.kind), ['remember']);
    const doing = activitiesFromInnerChoice(kept, at, '相机焦距', '去看书')!;
    assert.deepEqual(doing.activities.map(item => item.kind), ['research', 'adjust_schedule']);
    assert.equal(doing.drive.source, 'internal');
    assert.equal(activitiesFromInnerChoice({ ...kept, goes: 'tell' }, at)?.activities[0]?.kind, 'message');
});
