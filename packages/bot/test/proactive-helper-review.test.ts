import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const planner = pathToFileURL(resolve(import.meta.dirname, '../src/proactive/proactive-planner.ts')).href;
const scheduleModule = pathToFileURL(resolve(import.meta.dirname, '../src/life/schedule.ts')).href;
const localDateModule = pathToFileURL(resolve(import.meta.dirname, '../src/local-date.ts')).href;
const schemaModule = pathToFileURL(resolve(import.meta.dirname, '../src/memory/state-schema.ts')).href;
const setup = `
import { newsFrom, reschedulesFrom, rainOf } from ${JSON.stringify(planner)};
import { formatDate, herDay } from ${JSON.stringify(scheduleModule)};
import { localDate } from ${JSON.stringify(localDateModule)};
import { calendarDate, stateTimestamp } from ${JSON.stringify(schemaModule)};
const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' },
 periods: {}, semester: { start: '2026-01-05', weeks: 52 }, holidays: [], makeups: [], courses: [],
 kinds: { hard: {}, machine: {}, water: {}, pe: {} }, free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '学校' };
`;

function probe(tz: string, body: string): unknown {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', setup + body], {
        env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}

test('newsFrom 在DST跳时前的凌晨按她的今天/明天取快照，不跳过中间日', () => {
    const calls = probe('America/New_York', `
 const calls = [];
 newsFrom(at => { calls.push(formatDate(herDay(schedule, at))); return undefined; }, schedule)(localDate(2026, 2, 8, 1, 30).getTime());
 console.log(JSON.stringify(calls));
 `) as string[];
    assert.deepEqual(calls.slice(0, 2), ['2026-03-07', '2026-03-08']);
});

test('newsFrom 末年只执行支持范围内的世界投影，不调用10000年导致整个规划失败', () => {
    const calls = probe('Asia/Shanghai', `
 const calls = [];
 const items = newsFrom(at => {
   if (!calendarDate(formatDate(at)) || !stateTimestamp(at.toISOString())) throw new RangeError('合成worldAt拒绝出界投影');
   calls.push(formatDate(at)); return undefined;
 }, schedule)(localDate(9999, 11, 31, 12).getTime());
 console.log(JSON.stringify({ calls, items }));
 `) as { calls: string[]; items: unknown[] };
    assert.ok(calls.calls.length > 0);
    assert.ok(calls.calls.every(day => day === '9999-12-31'));
    assert.deepEqual(calls.items, []);
});

test('newsFrom 不任意排除合法0000年份，纯计算窗口不变成现代日期', () => {
    const calls = probe('Asia/Shanghai', `
 const calls = [];
 newsFrom(at => { calls.push({ day: formatDate(at), valid: calendarDate(formatDate(at)) && stateTimestamp(at.toISOString()) }); return undefined; }, schedule)(localDate(0, 0, 1, 12).getTime());
 console.log(JSON.stringify(calls));
 `) as { day: string; valid: boolean }[];
    assert.ok(calls.some(call => call.day === '0000-01-01'));
    assert.ok(calls.every(call => call.valid));
});

test('reschedulesFrom 不为末年跨出支持范围的约执行下一年worldAt', () => {
    const result = probe('Asia/Shanghai', `
 const calls = [];
 const meeting = { contact: { qq: 10001, tier: 'boyfriend', name: '合成人' },
   promise: { id: 'p-1', what: '吃饭', date: '9999-12-31', said: '9999-12-29', episode: 'ep-1', meet: { time: '23:30', minutes: 60 } },
   start: localDate(9999, 11, 31, 23, 30), end: localDate(10000, 0, 1, 0, 30) };
 const items = reschedulesFrom({ qq: 10001, facts: { schedule, worldAt: at => {
   if (!calendarDate(formatDate(at)) || !stateTimestamp(at.toISOString())) throw new RangeError('合成worldAt拒绝出界投影');
   calls.push(formatDate(at)); return undefined;
 } }, appointments: () => [meeting] })(localDate(9999, 11, 30, 12).getTime());
 console.log(JSON.stringify({ calls, items }));
 `) as { calls: string[]; items: unknown[] };
    assert.ok(result.calls.every(day => /^9999-12-(30|31)$/.test(day)));
    assert.deepEqual(result.items, []);
});

test('rainOf 保留合法低年份和实况/预报约定，不把模拟雨当真实雨', () => {
    const result = probe('Asia/Shanghai', `
 const at = localDate(0, 0, 1, 10);
 const seen = { day: '0000-01-01', weather: { rain: true, low: 10, high: 20, real: true, rainHours: [8,9,10] } };
 const real = rainOf(seen, at);
 const forecast = rainOf({ day: seen.day, weather: { rain: false, low: 10, high: 20, real: true, laterHour: 15 } }, at);
 const generated = rainOf({ day: seen.day, weather: { rain: true, low: 10, high: 20 } }, at);
 console.log(JSON.stringify({ real: { ...real, start: formatDate(new Date(real.start)), hour: new Date(real.start).getHours() }, forecast: { ...forecast, hour: new Date(forecast.start).getHours() }, generated: generated ?? null }));
 `) as { real: { start: string; hour: number; forecast: boolean }; forecast: { hour: number; forecast: boolean }; generated: unknown };
    assert.deepEqual(result.real, { day: '0000-01-01', start: '0000-01-01', forecast: false, hour: 8 });
    assert.equal(result.forecast.hour, 15);
    assert.equal(result.forecast.forecast, true);
    assert.equal(result.generated, null);
});
