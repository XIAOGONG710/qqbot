import test from 'node:test';
import assert from 'node:assert/strict';
import { associateWorldEvent, appendWorldAssociations } from '../src/world/associations.ts';
import type { WorldEvent } from '../src/world/events.ts';

const weather: WorldEvent = {
    id: 'weather:1', source: 'world', kind: 'world.weather.observed', occurredAt: '2026-11-16T12:00:00.000Z', observedAt: '2026-11-16T12:00:00.000Z',
    status: 'active', details: { condition: '下雨' }, confidence: 0.9,
};

test('a world event can leave multiple bounded association paths without inventing a memory', () => {
    const associations = associateWorldEvent(weather);
    assert.deepEqual(associations.map(item => [item.lane, item.focus]), [
        ['contextual', '更新当前情境'], ['practical', '评估环境对安排的影响'], ['episodic', '按需检索相关经历'],
    ]);
    assert.doesNotMatch(JSON.stringify(associations), /下雨/);
});

test('associations require an event and remain idempotent', () => {
    const associations = associateWorldEvent(weather);
    assert.equal(appendWorldAssociations([weather], [], [...associations, ...associations]).length, 3);
    assert.throws(() => appendWorldAssociations([], [], associations), /不存在的事件/);
});
