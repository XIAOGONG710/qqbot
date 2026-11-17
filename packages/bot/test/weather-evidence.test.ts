import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observedWeatherEvent, resolveWeather, type WeatherEvidence } from '../src/world/weather-evidence.ts';

const now = Date.parse('2026-11-17T09:30:00.000Z');
const evidence = (kind: WeatherEvidence['kind'], condition: WeatherEvidence['condition'], sourceId: string, confidence = 1, observedAt = '2026-11-17T09:20:00.000Z'): WeatherEvidence => ({
    location: 'school', kind, condition, sourceId, confidence, observedAt, validUntil: '2026-11-17T10:00:00.000Z',
});

test('预报不冒充实况，用户或设备的在地观察可以校正天气软件', () => {
    const predicted = resolveWeather([evidence('forecast', 'rain', 'weather-app')], 'school', now);
    assert.equal(predicted.actual.status, 'unavailable');
    assert.equal(predicted.forecast.status, 'fresh');

    const corrected = resolveWeather([
        evidence('service', 'dry', 'weather-app'),
        evidence('device', 'dry', 'campus-sensor'),
        evidence('user', 'rain', 'owner-report'),
    ], 'school', now);
    assert.equal(corrected.actual.status, 'fresh');
    if (corrected.actual.status === 'fresh') assert.deepEqual([corrected.actual.value, corrected.actual.source], ['rain', 'owner-report']);
});

test('同级证据冲突时不猜；过期的现场观察让位给仍新鲜的实况', () => {
    const conflict = resolveWeather([
        evidence('user', 'rain', 'report-a'), evidence('user', 'dry', 'report-b'),
    ], 'school', now);
    assert.equal(conflict.actual.status, 'conflict');
    const stale = { ...evidence('user', 'rain', 'owner-report'), observedAt: '2026-11-17T08:00:00.000Z', validUntil: '2026-11-17T08:30:00.000Z' };
    const fallback = resolveWeather([stale, evidence('service', 'dry', 'weather-app')], 'school', now);
    assert.equal(fallback.actual.status, 'fresh');
    if (fallback.actual.status === 'fresh') assert.equal(fallback.actual.value, 'dry');
});

test('只有裁决后的新鲜实况进入世界事件', () => {
    const resolved = resolveWeather([evidence('device', 'rain', 'campus-sensor')], 'school', now);
    const event = observedWeatherEvent('school', resolved, new Date(now));
    assert.equal(event?.kind, 'world.weather.truth');
    assert.deepEqual(event?.details, { location: 'school', condition: 'rain', evidenceSource: 'campus-sensor' });
    assert.equal(observedWeatherEvent('school', resolveWeather([evidence('forecast', 'rain', 'weather-app')], 'school', now), new Date(now)), undefined);
});
