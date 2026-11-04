import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorldEvidence } from '../src/world/evidence-registry.ts';

test('世界证据注册表汇总新鲜、冲突和过期事实，且不回显值', () => {
    const now = Date.parse('2026-11-04T06:00:00Z');
    const at = '2026-11-04T05:55:00Z';
    const validUntil = '2026-11-04T06:30:00Z';
    const candidates = [
        { key: 'weather.home', value: 'rain', source: 'a', observedAt: at, validUntil, priority: 10 },
        { key: 'weather.home', value: 'sun', source: 'b', observedAt: at, validUntil, priority: 10 },
        { key: 'calendar.today', value: 'workday', source: 'c', observedAt: at, validUntil, priority: 20 },
        { key: 'transport.school', value: 'normal', source: 'd', observedAt: '2026-11-03T00:00:00Z', validUntil: '2026-11-03T01:00:00Z', priority: 5 },
    ];
    const result = resolveWorldEvidence(candidates, now);
    assert.deepEqual(result.report, { keys: 3, fresh: 1, conflicts: 1, stale: 1, unavailable: 0, sources: 4, healthy: false });
    assert.equal(result.facts.get('weather.home')?.status, 'conflict');
    assert.doesNotMatch(JSON.stringify(result.report), /rain|sun|home|school/);
});
