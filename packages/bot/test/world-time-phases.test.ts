import test from 'node:test';
import assert from 'node:assert/strict';
import { timePhaseEvents, timePhaseTransitions, timePhases } from '../src/world/time-phases.ts';

test('world clock projects day, week, month and season phases', () => {
    assert.deepEqual(timePhases(new Date(2026, 0, 3, 5, 30)), {
        dayPhase: 'night', weekPhase: 'weekend', monthPhase: 'early', season: 'winter',
    });
    assert.deepEqual(timePhases(new Date(2026, 6, 15, 12, 0)), {
        dayPhase: 'noon', weekPhase: 'weekday', monthPhase: 'middle', season: 'summer',
    });
});

test('world clock emits only changed phase events', () => {
    const before = timePhases(new Date(2026, 0, 9, 10, 59));
    const events = timePhaseEvents(before, new Date(2026, 0, 11, 12, 0));
    assert.deepEqual(events.map(event => event.kind), [
        'time.dayPhase.changed', 'time.weekPhase.changed', 'time.monthPhase.changed',
    ]);
    assert.deepEqual(events.map(event => event.details), [
        { from: 'morning', to: 'noon' },
        { from: 'weekday', to: 'weekend' },
        { from: 'early', to: 'middle' },
    ]);
});

test('world clock replays every deterministic boundary crossed while offline', () => {
    const observed = new Date(2026, 0, 11, 15, 20);
    const events = timePhaseTransitions(new Date(2026, 0, 10, 22, 30), observed);
    assert.deepEqual(events.map(event => [event.kind, event.details?.from, event.details?.to]), [
        ['time.dayPhase.changed', 'evening', 'late-night'],
        ['time.dayPhase.changed', 'late-night', 'night'],
        ['time.monthPhase.changed', 'early', 'middle'],
        ['time.dayPhase.changed', 'night', 'morning'],
        ['time.dayPhase.changed', 'morning', 'noon'],
        ['time.dayPhase.changed', 'noon', 'afternoon'],
    ]);
    assert.deepEqual(events.map(event => event.occurredAt), [
        new Date(2026, 0, 10, 23).toISOString(),
        new Date(2026, 0, 11, 0).toISOString(),
        new Date(2026, 0, 11, 0).toISOString(),
        new Date(2026, 0, 11, 6).toISOString(),
        new Date(2026, 0, 11, 11).toISOString(),
        new Date(2026, 0, 11, 14).toISOString(),
    ]);
    assert.ok(events.every(event => event.observedAt === observed.toISOString()));
});

