import test from 'node:test';
import assert from 'node:assert/strict';
import { appendWorldImpacts, validWorldImpact, type WorldImpact } from '../src/world/impacts.ts';
import type { WorldEvent } from '../src/world/events.ts';

const event: WorldEvent = {
    id: 'weather:rain', source: 'world', kind: 'weather.started',
    occurredAt: '2026-11-16T09:00:00.000Z', observedAt: '2026-11-16T09:01:00.000Z',
    status: 'active', confidence: 0.95,
};
const impact = (id: string, target: string): WorldImpact => ({
    id, eventId: event.id, target, aspect: 'commute', direction: 'negative',
    magnitude: 0.6, confidence: 0.8, assessedAt: '2026-11-16T09:02:00.000Z',
});

test('world impacts validate direction, magnitude and time bounds', () => {
    assert.equal(validWorldImpact(impact('weather:rain:user', 'user:1')), true);
    assert.equal(validWorldImpact({ ...impact('bad', 'user:1'), magnitude: 1.01 }), false);
    assert.equal(validWorldImpact({ ...impact('bad-time', 'user:1'), validUntil: '2026-11-16T09:01:00.000Z' }), false);
});

test('world impacts are event-bound, idempotent and stable', () => {
    const first = impact('weather:rain:user', 'user:1');
    const second = impact('weather:rain:relationship', 'relationship:1');
    assert.deepEqual(appendWorldImpacts([event], [first], [first, second]).map(item => item.id), [second.id, first.id]);
    assert.throws(() => appendWorldImpacts([], [], [first]), /不存在的事件/);
});

