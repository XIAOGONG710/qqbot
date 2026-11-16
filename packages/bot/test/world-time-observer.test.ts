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
    assert.equal(observer.observe(new Date(2026, 0, 11, 12, 0)), 3);
    assert.deepEqual(ledger.events().map(event => event.kind), [
        'time.dayPhase.changed', 'time.monthPhase.changed', 'time.weekPhase.changed',
    ]);
});

test('time observer reload does not repeat an already observed change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-time-observer-'));
    const ledger = readWorldEventLedger(join(dir, 'events.json'));
    const path = join(dir, 'time.json');
    readTimeObserver(path, new Date(2026, 0, 9, 10, 0), ledger).observe(new Date(2026, 0, 11, 12, 0));
    const resumed = readTimeObserver(path, new Date(2026, 0, 11, 12, 0), ledger);
    assert.equal(resumed.observe(new Date(2026, 0, 11, 12, 20)), 0);
    assert.equal(ledger.events().length, 3);
});

