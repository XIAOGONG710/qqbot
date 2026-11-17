import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorldEventLedger } from '../src/world/event-ledger.ts';
import { readTimeObserver } from '../src/world/time-observer.ts';

test('time observer establishes a baseline and emits only later phase changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-time-observer-'));
    const ledger = readWorldEventLedger(join(dir, 'events.json'));
    const observer = readTimeObserver(join(dir, 'time.json'), new Date(2026, 0, 9, 10, 0), ledger);
    assert.equal(observer.observe(new Date(2026, 0, 9, 10, 30)), 0);
    assert.equal(observer.observe(new Date(2026, 0, 11, 12, 0)), 15);
    assert.equal(ledger.events().filter(event => event.kind === 'time.dayPhase.changed').length, 13);
    assert.equal(ledger.events().filter(event => event.kind === 'time.monthPhase.changed').length, 1);
    assert.equal(ledger.events().filter(event => event.kind === 'time.weekPhase.changed').length, 1);
});

test('time observer reload does not repeat an already observed change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-time-observer-'));
    const ledger = readWorldEventLedger(join(dir, 'events.json'));
    const path = join(dir, 'time.json');
    readTimeObserver(path, new Date(2026, 0, 9, 10, 0), ledger).observe(new Date(2026, 0, 11, 12, 0));
    const resumed = readTimeObserver(path, new Date(2026, 0, 11, 12, 0), ledger);
    assert.equal(resumed.observe(new Date(2026, 0, 11, 12, 20)), 0);
    assert.equal(ledger.events().length, 15);
});

test('time observer restores deterministic continuity after downtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-time-observer-'));
    const ledger = readWorldEventLedger(join(dir, 'events.json'));
    const observer = readTimeObserver(join(dir, 'time.json'), new Date(2026, 0, 10, 22, 30), ledger);
    assert.equal(observer.observe(new Date(2026, 0, 11, 15, 20)), 6);
    assert.deepEqual(ledger.events().map(event => event.details?.to), ['late-night', 'night', 'middle', 'morning', 'noon', 'afternoon']);
    assert.deepEqual(ledger.events().map(event => event.occurredAt), [
        new Date(2026, 0, 10, 23).toISOString(), new Date(2026, 0, 11, 0).toISOString(), new Date(2026, 0, 11, 0).toISOString(),
        new Date(2026, 0, 11, 6).toISOString(), new Date(2026, 0, 11, 11).toISOString(), new Date(2026, 0, 11, 14).toISOString(),
    ]);
});

