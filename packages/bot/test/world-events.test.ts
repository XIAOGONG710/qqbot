import test from 'node:test';
import assert from 'node:assert/strict';
import { appendWorldEvents, validWorldEvent, type WorldEvent } from '../src/world/events.ts';

const event = (id: string, occurredAt: string): WorldEvent => ({
    id, source: 'world', kind: 'weather.started', occurredAt,
    observedAt: '2026-11-16T10:00:00.000Z', status: 'active', confidence: 0.9,
});

test('world events validate structured, time-bounded facts', () => {
    assert.equal(validWorldEvent(event('rain-1', '2026-11-16T09:00:00.000Z')), true);
    assert.equal(validWorldEvent({ ...event('bad', '2026-11-16T09:00:00.000Z'), confidence: 1.1 }), false);
    assert.equal(validWorldEvent({ ...event('bad-time', '2026-11-16T09:00:00.000Z'), validUntil: '2026-11-15T09:00:00.000Z' }), false);
    assert.equal(validWorldEvent({ ...event('bad-value', '2026-11-16T09:00:00.000Z'), details: { raw: [] } }), false);
});

test('world events append idempotently and keep deterministic chronology', () => {
    const first = event('first', '2026-11-16T09:00:00.000Z');
    const second = event('second', '2026-11-16T08:00:00.000Z');
    assert.deepEqual(
        appendWorldEvents([first], [first, second]).map(item => item.id),
        ['second', 'first'],
    );
});

