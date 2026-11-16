import test from 'node:test';
import assert from 'node:assert/strict';
import { internalDrivesAt, shadowActivityFor, validDrive, type Drive } from '../src/life/motivation.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const at = new Date('2026-11-16T12:00:00.000Z');
const calm: RegulationSnapshot = { at: at.toISOString(), discomfort: 0, arousal: 0.2, recoveryNeed: 0.2, socialCapacity: 0.8, cognitiveCapacity: 0.8 };
const external: Drive = {
    id: 'drive:rain:remember', source: 'external', goal: '记住天气变化', eventIds: ['weather:rain'],
    strength: 0.4, urgency: 0.1, persistence: 0.5, createdAt: at.toISOString(), status: 'active',
};

test('external drives require an auditable event or impact origin', () => {
    assert.equal(validDrive(external), true);
    assert.equal(validDrive({ ...external, eventIds: undefined }), false);
    assert.equal(validDrive({ ...external, goal: 'x'.repeat(161) }), false);
});

test('shadow activities remember or wait but never produce an external action', () => {
    assert.deepEqual(shadowActivityFor(external, calm, at), {
        id: 'drive:rain:remember:remember', driveId: external.id, kind: 'remember', createdAt: at.toISOString(), reason: '影子模式只保留动机，不替她外发',
    });
    assert.equal(shadowActivityFor(external, { ...calm, recoveryNeed: 0.8 }, at)?.kind, 'wait');
});

test('functional regulation creates auditable internal drives without inventing social desire', () => {
    const regulation: RegulationSnapshot = { at: '2026-11-16T12:00:00.000Z', discomfort: 0.82, arousal: 0.75, recoveryNeed: 0.9, socialCapacity: 0.2, cognitiveCapacity: 0.3 };
    const drives = internalDrivesAt(regulation);
    assert.deepEqual(drives.map(drive => drive.stateKeys), [
        ['regulation.recoveryNeed'], ['regulation.discomfort'], ['regulation.arousal'], ['regulation.socialCapacity'], ['regulation.cognitiveCapacity'],
    ]);
    assert.ok(drives.every(drive => drive.source === 'internal' && validDrive(drive)));
    assert.deepEqual(internalDrivesAt({ ...regulation, recoveryNeed: 0.2, discomfort: 0.1, arousal: 0.2, socialCapacity: 0.9, cognitiveCapacity: 0.9 }), []);
});

