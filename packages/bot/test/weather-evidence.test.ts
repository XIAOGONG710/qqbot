import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    observedWeatherEvent, parseWeatherObservation, readWeatherEvidenceLedger, reconciledWeather, resolveWeather, userWeatherEvidence, type WeatherEvidence,
} from '../src/world/weather-evidence.ts';
import type { DayWeather, WeatherFetcher, WeatherFetcherStatus } from '../src/world/weather.ts';

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

test('自然语言现场观察必须明确地点、是陈述且不是软件转述', () => {
    assert.deepEqual(parseWeatherObservation('我这里下雨了'), { target: 'user', condition: 'rain' });
    assert.deepEqual(parseWeatherObservation('你学校那边没下雨'), { target: 'school', condition: 'dry' });
    assert.deepEqual(parseWeatherObservation('你那边下雪了'), { target: 'current', condition: 'snow' });
    assert.deepEqual(parseWeatherObservation('你那边没下雪'), { target: 'current', condition: 'dry' });
    assert.equal(parseWeatherObservation('你那边下雨了吗？'), undefined);
    assert.equal(parseWeatherObservation('天气软件说你那边下雨了'), undefined);
    assert.equal(parseWeatherObservation('我这里下雨，你那边没下'), undefined);
    assert.equal(parseWeatherObservation('我这里下雨了，你那边没下'), undefined, '一句话涉及两个地点时不猜');
    assert.equal(parseWeatherObservation('下雨了'), undefined, '没有地点归属时不猜');
});

const day: DayWeather = { rain: false, low: 8, high: 17, real: true, now: { text: '多云', temp: 12 }, rainHours: [], later: '预报 17 点后有雨', laterHour: 17 };
const status = (stale: boolean): WeatherFetcherStatus => ({
    provider: 'weather-app', cacheMaxAgeMs: 2 * 60 * 60_000, fetchedAt: '2026-11-17T09:20:00.000Z',
    places: { school: { fetchedAt: '2026-11-17T09:20:00.000Z', ageMs: stale ? 9_000_000 : 600_000, stale, hours: 48, since: '2026-11-01' } },
});
const source = (stale = false): WeatherFetcher => ({
    refresh: async () => {}, status: () => status(stale), day: (_place, date) => date === '2026-11-17' ? day : undefined,
});

test('证据账持久化现场观察，同一来源的新纠正覆盖旧观察', () => {
    const ledger = readWeatherEvidenceLedger(join(mkdtempSync(join(tmpdir(), 'weather-evidence-')), 'evidence.json'));
    const rain = userWeatherEvidence('school', 'rain', new Date('2026-11-17T09:25:00.000Z'))!;
    const dry = userWeatherEvidence('school', 'dry', new Date('2026-11-17T09:35:00.000Z'))!;
    assert.equal(ledger.append(rain), true);
    assert.equal(ledger.append(rain), false);
    assert.equal(ledger.append(dry), true);
    assert.deepEqual(ledger.evidence().map(item => item.condition), ['dry']);
    assert.equal(ledger.append(rain), false, '迟到的旧观察不能覆盖更新的现场纠正');
});

test('统一读口用用户现场纠正软件，但用户所在地不会串到她学校', () => {
    const ledger = readWeatherEvidenceLedger(join(mkdtempSync(join(tmpdir(), 'weather-evidence-')), 'evidence.json'));
    ledger.append(userWeatherEvidence('user', 'rain', new Date('2026-11-17T09:25:00.000Z'))!);
    const reality = reconciledWeather(source(), ledger);
    const at = new Date('2026-11-17T09:30:00.000Z');
    assert.equal(reality.day('school', '2026-11-17', at)?.now?.text, '无降水');
    ledger.append(userWeatherEvidence('school', 'rain', new Date('2026-11-17T09:26:00.000Z'))!);
    const corrected = reality.day('school', '2026-11-17', at);
    assert.equal(corrected?.now?.text, '下雨');
    assert.equal(corrected?.rainHours?.includes(at.getHours()), true);
});

test('软件实况过期且没有新鲜现场观察时，权威读口返回未知', () => {
    const ledger = readWeatherEvidenceLedger(join(mkdtempSync(join(tmpdir(), 'weather-evidence-')), 'evidence.json'));
    const reality = reconciledWeather(source(true), ledger);
    assert.equal(reality.authoritative, true);
    assert.equal(reality.day('school', '2026-11-17', new Date('2026-11-17T12:30:00.000Z')), undefined);
});

test('软件缓存虽已过期，新鲜的同地点现场观察仍能确认当前天气', () => {
    const ledger = readWeatherEvidenceLedger(join(mkdtempSync(join(tmpdir(), 'weather-evidence-')), 'evidence.json'));
    ledger.append(userWeatherEvidence('school', 'rain', new Date('2026-11-17T09:25:00.000Z'))!);
    const reality = reconciledWeather(source(true), ledger);
    const corrected = reality.day('school', '2026-11-17', new Date('2026-11-17T09:30:00.000Z'));
    assert.equal(corrected?.now?.text, '下雨');
    assert.equal(corrected?.rainHours?.includes(17), true);
});
