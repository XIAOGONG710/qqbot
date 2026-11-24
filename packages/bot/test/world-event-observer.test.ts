import test from 'node:test';
import assert from 'node:assert/strict';
import { observeWorldNow } from '../src/world/world-event-observer.ts';
import type { WorldNow } from '../src/world/world.ts';

const at = new Date('2026-11-16T12:30:00.000Z');

test('world observation projects existing environmental facts without third-party detail or location', () => {
    const now: WorldNow = {
        day: '2026-11-16', atSchool: true,
        weather: { rain: true, low: 8, high: 15, real: true, now: { text: '下小雨', temp: 10 } },
        airQuality: { pm25: 12, pm10: 20, aqi: 33, category: '优', observedAt: at.toISOString(), real: true },
        daylight: { sunrise: '2026-11-16T06:30', sunset: '2026-11-16T17:20', phase: '白天', real: true },
        holiday: { name: '校庆假', start: '2026-11-16', end: '2026-11-16', home: false },
        publicHoliday: { date: '2026-11-16', name: '调休', kind: 'workday', real: true },
        parcels: [], homework: [], events: [],
    };
    const events = observeWorldNow(now, at);
    assert.deepEqual(events.map(event => [event.source, event.kind]), [
        ['world', 'world.weather.observed'], ['world', 'world.air.quality.observed'], ['world', 'world.daylight.phase.observed'],
        ['sandbox', 'sandbox.holiday.context'], ['society', 'society.public_holiday.observed'],
        ['sandbox', 'sandbox.presence.context'],
    ]);
});

test('world observation uses stable ids within an hour and records a changed local context separately', () => {
    const school: WorldNow = { day: '2026-11-16', atSchool: true, parcels: [], homework: [], events: [] };
    const home: WorldNow = { ...school, atSchool: false };
    assert.equal(observeWorldNow(school, at)[0]?.id, observeWorldNow(school, new Date('2026-11-16T12:55:00.000Z'))[0]?.id);
    assert.notEqual(observeWorldNow(school, at)[0]?.id, observeWorldNow(home, at)[0]?.id);
});
