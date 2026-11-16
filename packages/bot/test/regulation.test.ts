import test from 'node:test';
import assert from 'node:assert/strict';
import { regulationAt } from '../src/life/regulation.ts';

const at = '2026-11-16T12:00:00.000Z';

test('regulation derives a calm high-capacity snapshot from rested needs', () => {
    assert.deepEqual(regulationAt({ at, energy: 90, hunger: 10, stress: 10 }), {
        at, discomfort: 0, arousal: 0.09, recoveryNeed: 0.1, socialCapacity: 0.9, cognitiveCapacity: 0.905,
    });
});

test('regulation reflects body discomfort without treating it as a diagnosis', () => {
    const baseline = regulationAt({ at, energy: 55, hunger: 35, stress: 30 });
    const unwell = regulationAt({ at, energy: 55, hunger: 35, stress: 30 }, { period: { day: 1, cramps: 'bad', detail: true } });
    assert.equal(unwell.discomfort, 0.85);
    assert.equal(unwell.recoveryNeed, 0.85);
    assert.ok(unwell.socialCapacity < baseline.socialCapacity);
    assert.ok(unwell.cognitiveCapacity < baseline.cognitiveCapacity);
});

