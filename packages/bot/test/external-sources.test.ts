import test from 'node:test';
import assert from 'node:assert/strict';
import { externalObservationEvent, validExternalSourceConfig } from '../src/world/external-sources.ts';
test('external sources are explicit, disabled by config, and never carry credentials', () => {
    assert.equal(validExternalSourceConfig({ id: 'campus-feed', kind: 'campus', enabled: false, locationPrecision: 'coarse', maxAgeMs: 60_000 }), true);
    assert.equal(validExternalSourceConfig({ id: 'news', kind: 'news', enabled: true, endpoint: 'https://x.test/feed?token=secret', locationPrecision: 'none', maxAgeMs: 60_000 }), false);
});
test('external observations retain only a bounded label', () => {
    const at = new Date('2026-11-16T12:00:00.000Z');
    const event = externalObservationEvent({ sourceId: 'news-rss', kind: 'news', occurredAt: at, label: '公共事件更新', confidence: 0.8 }, at)!;
    assert.deepEqual(event.details, { source: 'news-rss', label: '公共事件更新' });
});
