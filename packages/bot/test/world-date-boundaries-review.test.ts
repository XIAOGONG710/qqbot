import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDate } from '../src/local-date.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';
import { simulateWorld, worldAt, worldState, worldNews, type World } from '../src/world/world.ts';
import { npcStates } from '../src/world/npc.ts';
import { DEFAULT_ASKS, npcAsksBetween } from '../src/world/npc-asks.ts';
import { meetupDays, obstaclesBetween } from '../src/world/obstacles.ts';
import { festivalActivities, festivalYears } from '../src/world/festivals.ts';
import { firstRealDay, dayFrom, type HourWeather } from '../src/world/weather.ts';

const schedule = (start = '0099-11-01'): Schedule => ({ sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: 'one' },
 periods: { one: { start: '08:00', end: '10:00' } }, semester: { start, weeks: 8 }, holidays: [], makeups: [],
 kinds: { hard: {}, machine: {}, pe: {}, water: {} }, courses: [{ day: 4, slot: 'one', weeks: '1-8', kind: 'hard', name: '合成课' }],
 free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成地点' });
const world = (startDay = '0099-11-01'): World => ({ startDay, awayHolidays: [], people: [], events: [] });
const at = (date: string) => new Date(date);

test('0099世界逐日重放和作业保留真实年，跨0100年不跳到1999', () => {
 const w = { ...world(), homework: { kinds: ['hard'], chance: 1, earlyChance: 0 } };
 const timeline = simulateWorld(w, schedule(), at('0099-11-20T23:00:00'));
 assert.equal(timeline.days.size, 20);
 assert.ok(timeline.homework.length > 0);
 for (const h of timeline.homework) assert.equal(h.due.getFullYear(), 99);
 assert.equal(worldAt(w, schedule(), at('0099-11-05T12:00:00'))!.day, '0099-11-05');
 assert.deepEqual([...simulateWorld(world('0099-12-30'), schedule('0099-12-30'), at('0100-01-02T12:00:00')).days.keys()], ['0099-12-30', '0099-12-31', '0100-01-01', '0100-01-02']);
});

test('0000闰日及跨月日循环保留，0000午后瞬时仍可投影', () => {
 assert.deepEqual([...simulateWorld(world('0000-02-28'), schedule('0000-02-28'), at('0000-03-01T12:00:00')).days.keys()], ['0000-02-28', '0000-02-29', '0000-03-01']);
 assert.equal(worldAt(world('0000-01-01'), schedule('0000-01-01'), at('0000-01-01T12:00:00'))!.day, '0000-01-01');
});

test('0099NPC月度状态与邀请不丢失且所有输出时刻保留低年份', () => {
 const s = schedule();
 assert.ok(Array.from({ length: 30 }, (_, i) => npcStates('synthetic', { sick: { perMonth: 31, days: [14, 14] } }, s, localDate(99, 10, i + 1))).some(states => states.some(item => item.kind === 'sick')));
 const asks = npcAsksBetween([{ id: 'synthetic', name: '合成人' }], s, localDate(99, 10, 1), localDate(99, 10, 30), { synthetic: { ...Object.values(DEFAULT_ASKS)[0]!, perMonth: 31 } });
 assert.ok(asks.length > 0);
 assert.ok(asks.every(ask => ask.day.startsWith('0099-') && ask.start.getFullYear() === 99 && ask.askedAt.getFullYear() === 99));
});

test('0099见面日和有课障碍使用真实低年份', () => {
 assert.equal(formatDate(meetupDays('明天', localDate(99, 10, 5))[0]!), '0099-11-06');
 const found = obstaclesBetween(localDate(99, 10, 1), localDate(99, 10, 8), { schedule: schedule() });
 assert.ok(found.some(item => item.kind === 'class'));
 assert.ok(found.every(item => item.start.getFullYear() === 99 && item.end.getFullYear() === 99));
});

test('低年份节日活动日期和天气跨日键是四位年，现代日期锚点不变', () => {
 assert.ok(festivalActivities([99], 'notes').some(item => item.date === '0099-12-24'));
 assert.equal(firstRealDay(localDate(99, 11, 31, 12)), '0100-01-01');
 assert.equal(firstRealDay(localDate(2026, 10, 5, 12)), '2026-11-06');
 const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => ['0099-11-05T' + String(h).padStart(2, '0'), { t: h, p: 0, c: 2, o: 1 }])) as Record<string, HourWeather>;
 assert.deepEqual(dayFrom(hours, '0099-11-05', localDate(99, 10, 5, 12))!.now, { text: '多云', temp: 12 });
});

test('末年快递和补粮后续订单出界明确失败，不输出五位日期', () => {
 const parcels = { perWeek: 7, arriveDays: [1, 1] as [number, number], keepDays: 1, items: ['合成物品'] };
 assert.throws(() => simulateWorld({ ...world('9999-12-30'), parcels }, schedule('9999-12-30'), localDate(9999, 11, 31, 12)), RangeError);
 const cat = { name: '合成猫', feed: ['18:00', '20:00'] as [string, string], seenChance: 1, food: { left: 2, reorderAt: 0, bagDays: 7 } };
 assert.throws(() => simulateWorld({ ...world('9999-12-29'), cat }, schedule('9999-12-29'), localDate(9999, 11, 31, 23)), RangeError);
});

test('末年下一课停止搜索、末日天气不伪造下一日，公历或ISO瞬时出界明确拒绝', () => {
 const w = { ...world('9999-12-31'), homework: { kinds: ['hard'], chance: 1, earlyChance: 0 } };
 const s = schedule('9999-12-31'); s.courses[0]!.day = localDate(9999, 11, 31).getDay() || 7;
 assert.deepEqual(simulateWorld(w, s, localDate(9999, 11, 31, 23)).homework, []);
 assert.deepEqual(festivalYears(localDate(9999, 11, 31)), [9999]);
 assert.throws(() => firstRealDay(localDate(9999, 11, 31, 12)), RangeError);
 assert.throws(() => simulateWorld(world(), schedule(), localDate(10000, 0, 1)), RangeError);
 assert.throws(() => simulateWorld(world('0000-01-01'), schedule('0000-01-01'), localDate(0, 0, 1, 1)), RangeError);
});


test('末年相机结束和饭点时长越界在输出前失败', () => {
 const startDay = '9999-12-31';
 const w: World = { ...world(startDay), cameraFund: { goal: 1, saved: 1, weekly: 0, depositDay: 1,
 purchase: { date: startDay, from: '23:59', minutes: 2, where: '合成地点', what: '合成相机', price: 1 } } };
 assert.throws(() => simulateWorld(w, schedule(startDay), localDate(9999, 11, 31, 23, 59)), RangeError);
 const routine: NonNullable<World['routine']> = { lunch: { from: '12:00', spread: 0, minutes: 30 }, dinner: { from: '23:59', spread: 0, minutes: 2 }, takeoutChance: 0, shower: { from: '20:00', spread: 0, minutes: [10, 10], chance: 0 } };
 assert.throws(() => worldAt({ ...world(startDay), routine }, schedule(startDay), localDate(9999, 11, 31, 23)), RangeError);
});

test('越界事件草稿不进入权威账及兼容投影文件', () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-date-'));
 try {
  const state = worldState(world('0000-01-01'), schedule('0000-01-01'), () => {}, dir, () => localDate(0, 0, 2, 12).getTime());
  state.recordEvents([{ id: 'synthetic', kind: 'synthetic', at: localDate(0, 0, 1, 1).toISOString(), source: 'external', result: 'succeeded' }]);
  assert.deepEqual(state.events(), []);
  assert.equal(existsSync(join(dir, 'events.json')), false);
  assert.equal(existsSync(join(dir, 'actions.json')), false);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('末日天气仍可读已有23时实况，照片延迟不能生成越界通知', () => {
 const hours = Object.fromEntries(Array.from({ length: 24 }, (_, h) => ['9999-12-31T' + String(h).padStart(2, '0'), { t: 20, p: 0, c: 61, o: 1 }])) as Record<string, HourWeather>;
 assert.equal(dayFrom(hours, '9999-12-31', localDate(9999, 11, 31, 23))!.rain, true);
 // 用稳定日期种子挑出的有照片日，输入仍是末年最后一刻，延迟之后已不受支持。
 let exercised = false;
 for (let day = 1; day <= 31; day++) {
  const snapshot = { day: '9999-12-' + String(day).padStart(2, '0'), atSchool: true, parcels: [], homework: [], events: [],
   cat: { name: '合成猫', foodDays: 1, yesterdayFed: false, today: { fed: localDate(9999, 11, 31, 23, 59), seen: true } } };
  try { worldNews(snapshot, ['cat_photo']); } catch (error) { assert.ok(error instanceof RangeError); exercised = true; break; }
 }
 assert.ok(exercised);
});

test('末日猫后日常事件跨出四位本地年时投影明确失败', () => {
 const start = '9999-12-31';
 const w: World = { ...world(start), cat: { name: '合成猫', feed: ['23:58', '23:59'], seenChance: 1,
  food: { left: 2, reorderAt: -1, bagDays: 7 } }, events: [{ id: 'synthetic', text: '合成事件',
  window: 'evening', when: 'any', chance: 1, everyday: true, requires: 'cat_seen' }] };
 assert.throws(() => simulateWorld(w, schedule(start), localDate(9999, 11, 31, 23, 59)), RangeError);
 const modern = { ...w, startDay: '2026-11-05' };
 const events = simulateWorld(modern, schedule(modern.startDay), localDate(2026, 10, 5, 23, 59)).days.get(modern.startDay)!.events;
 assert.equal(events.length, 1);
 assert.equal(events[0]!.at.getFullYear(), 2026);
});
