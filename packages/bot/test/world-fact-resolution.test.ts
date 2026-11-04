import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorldFact, type SourcedFact } from '../src/world/fact-resolution.ts';

const now = Date.parse('2026-11-04T06:00:00.000Z');
const fact = (source: string, value: number, priority = 10, observedAt = '2026-11-04T05:55:00.000Z'): SourcedFact<number> => ({
    key: 'temperature', source, value, priority, observedAt, validUntil: '2026-11-04T06:15:00.000Z',
});

test('现实事实优先高可信新鲜来源，并保留来源与有效期', () => {
    const result = resolveWorldFact('temperature', [fact('社区源', 31, 1), fact('官方源', 30, 20)], { now });
    assert.deepEqual(result, { status: 'fresh', value: 30, source: '官方源', observedAt: '2026-11-04T05:55:00.000Z', validUntil: '2026-11-04T06:15:00.000Z', candidates: 2 });
});

test('同级近时来源冲突时不猜，过期或明显未来数据不冒充当前事实', () => {
    assert.deepEqual(resolveWorldFact('temperature', [fact('甲', 30), fact('乙', 35)], { now }), { status: 'conflict', sources: ['乙', '甲'], candidates: 2 });
    const stale = { ...fact('旧源', 30), observedAt: '2026-11-03T05:00:00.000Z', validUntil: '2026-11-03T06:00:00.000Z' };
    assert.deepEqual(resolveWorldFact('temperature', [stale], { now }), { status: 'stale', candidates: 1 });
    assert.equal(resolveWorldFact('temperature', [fact('未来源', 30, 10, '2026-11-04T08:00:00.000Z')], { now }).status, 'unavailable');
});
