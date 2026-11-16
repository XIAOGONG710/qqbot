import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorldEventLedger } from '../src/world/event-ledger.ts';
import type { WorldEvent } from '../src/world/events.ts';

const event = (id: string, occurredAt: string): WorldEvent => ({
    id, source: 'time', kind: 'time.phase.changed', occurredAt,
    observedAt: '2026-11-16T10:00:00.000Z', status: 'active', confidence: 1,
});

test('world event ledger appends atomically and ignores duplicate ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-event-ledger-'));
    const path = join(dir, 'events.json');
    const ledger = readWorldEventLedger(path);
    assert.equal(ledger.append([event('later', '2026-11-16T11:00:00.000Z'), event('first', '2026-11-16T09:00:00.000Z')]), 2);
    assert.equal(ledger.append([event('first', '2026-11-16T09:00:00.000Z')]), 0);
    assert.deepEqual(ledger.events().map(item => item.id), ['first', 'later']);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).events.map((item: WorldEvent) => item.id), ['first', 'later']);
});

test('world event ledger rejects malformed persisted data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-event-ledger-'));
    const path = join(dir, 'events.json');
    writeFileSync(path, JSON.stringify({ version: 1, events: [{ id: 'bad' }] }));
    assert.throws(() => readWorldEventLedger(path), /世界事件账/);
});

