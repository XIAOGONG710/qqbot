import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgencyShadow } from '../src/world/agency-shadow.ts';
import type { RegulationSnapshot } from '../src/life/regulation.ts';

const calm = (at: Date): RegulationSnapshot => ({ at: at.toISOString(), discomfort: 0, arousal: 0.1, recoveryNeed: 0.2, socialCapacity: 0.9, cognitiveCapacity: 0.9 });

test('agency shadow closes the time-event chain without an external action', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-agency-shadow-'));
    const initial = new Date(2026, 0, 9, 10, 0);
    const at = new Date(2026, 0, 11, 12, 0);
    const shadow = readAgencyShadow(dir, initial);
    assert.deepEqual(shadow.observe(at, calm(at)), { events: 3, impacts: 3, drives: 3, candidates: 3 });
    assert.equal(shadow.associations.associations().length, 6);
    assert.deepEqual(shadow.motivations.candidates().map(candidate => candidate.kind), ['remember', 'remember', 'remember']);
    assert.equal(shadow.observe(at, calm(at)).events, 0);
    assert.equal(shadow.motivations.candidates().length, 3);
});

test('agency shadow records message arrival without storing content or creating a drive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-agency-shadow-'));
    const at = new Date('2026-11-16T12:00:00.000Z');
    const shadow = readAgencyShadow(dir, at);
    assert.equal(shadow.recordUserMessage(123, 456, at, at), 1);
    assert.equal(shadow.recordUserMessage(123, 456, at, at), 0);
    assert.deepEqual(shadow.events.events().at(-1), {
        id: 'user-message:123:456', source: 'user', kind: 'user.message.received',
        occurredAt: at.toISOString(), observedAt: at.toISOString(), status: 'active',
        subjects: ['user:123'], details: { channel: 'private' }, confidence: 1,
    });
    assert.deepEqual(shadow.impacts.impacts(), []);
    assert.deepEqual(shadow.motivations.drives(), []);
    assert.deepEqual(shadow.observe(at, calm(at)), { events: 0, impacts: 0, drives: 0, candidates: 0 });
    assert.deepEqual(shadow.associations.associations(), [{
        id: 'association:user-message:123:456:relational', eventId: 'user-message:123:456', lane: 'relational',
        focus: '更新关系可用性', createdAt: at.toISOString(), confidence: 1,
    }]);
    assert.deepEqual(shadow.impacts.impacts(), []);
    assert.deepEqual(shadow.motivations.drives(), []);
});

test('agency shadow turns recorded world context into shadow-only motivations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-agency-shadow-'));
    const at = new Date('2026-11-16T12:00:00.000Z');
    const shadow = readAgencyShadow(dir, at);
    assert.equal(shadow.recordWorld({ day: '2026-11-16', atSchool: true, parcels: [], homework: [], events: [] }, at), 1);
    assert.deepEqual(shadow.observe(at, calm(at)), { events: 0, impacts: 1, drives: 1, candidates: 1 });
    assert.equal(shadow.motivations.candidates()[0]?.kind, 'remember');
    assert.deepEqual(shadow.events.events()[0]?.details, { day: '2026-11-16', place: 'school' });
    assert.deepEqual(shadow.associations.associations().map(association => association.lane), ['contextual', 'practical']);
});

test('agency shadow appends internal regulation drives without an external event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-agency-shadow-'));
    const at = new Date('2026-11-16T12:00:00.000Z');
    const shadow = readAgencyShadow(dir, at);
    const strained: RegulationSnapshot = { at: at.toISOString(), discomfort: 0.82, arousal: 0.75, recoveryNeed: 0.9, socialCapacity: 0.2, cognitiveCapacity: 0.3 };
    assert.deepEqual(shadow.observe(at, strained), { events: 0, impacts: 0, drives: 5, candidates: 5 });
    assert.ok(shadow.motivations.drives().every(drive => drive.source === 'internal'));
    assert.ok(shadow.motivations.candidates().every(candidate => candidate.kind === 'wait'));
});

