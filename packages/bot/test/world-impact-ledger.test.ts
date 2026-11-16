import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorldImpactLedger } from '../src/world/impact-ledger.ts';
import type { WorldEvent } from '../src/world/events.ts';
import type { WorldImpact } from '../src/world/impacts.ts';

const event: WorldEvent = {
    id: 'time:morning', source: 'time', kind: 'time.dayPhase.changed',
    occurredAt: '2026-11-16T06:00:00.000Z', observedAt: '2026-11-16T06:00:00.000Z', status: 'active', confidence: 1,
};
const impact: WorldImpact = {
    id: 'time:morning:her', eventId: event.id, target: 'self', aspect: 'availability',
    direction: 'uncertain', magnitude: 0.2, confidence: 1, assessedAt: '2026-11-16T06:00:00.000Z',
};

test('world impact ledger persists event-bound impacts idempotently', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qqbot-world-impact-ledger-')), 'impacts.json');
    const ledger = readWorldImpactLedger(path, () => [event]);
    assert.equal(ledger.append([impact]), 1);
    assert.equal(ledger.append([impact]), 0);
    assert.deepEqual(ledger.impacts(), [impact]);
});

test('world impact ledger refuses persisted impacts whose events are absent', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'qqbot-world-impact-ledger-')), 'impacts.json');
    writeFileSync(path, JSON.stringify({ version: 1, impacts: [impact] }));
    assert.throws(() => readWorldImpactLedger(path, () => []), /不存在的事件/);
});

