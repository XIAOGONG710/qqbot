import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withFestivalActivities, withFestivals } from '../src/world/festivals.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { ImportantDay } from '../src/proactive/proactive.ts';

const at = (value: string) => new Date(`${value}+08:00`);
const schedule = (): Schedule => ({ sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
    kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [], where: '宿舍',
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00',
        on: [{ date: '2026-11-05', window: 'evening', text: '作者的生日安排', home: false }] } });

test('节日活动合并保留作者 free.on，重复合并及 JSON 往返后仍幂等', () => {
    const value = schedule(); const own = structuredClone(value.free.on![0]);
    withFestivalActivities(value, at('2026-10-01T12:00:00'), 'notes');
    assert.ok(value.free.on!.some(item => JSON.stringify(item) === JSON.stringify(own)));
    const once = structuredClone(value.free.on);
    withFestivalActivities(value, at('2026-10-01T12:00:00'), 'notes');
    assert.deepEqual(value.free.on, once);
    const cloned = JSON.parse(JSON.stringify(value)) as Schedule;
    withFestivalActivities(cloned, at('2026-10-01T12:00:00'), 'greet');
    assert.deepEqual(cloned.free.on, once);
});

test('节日日历 notes/greet/off 切换只更新未来生成项，不删除同名作者日子', () => {
    const now = at('2026-11-05T12:00:00');
    const own: ImportantDay = { name: '元旦', date: '01-01', year: 2027, ahead: 1, hint: '作者自己的安排' };
    const notes = withFestivals([own], now, 'notes');
    const greet = withFestivals(JSON.parse(JSON.stringify(notes)) as ImportantDay[], now, 'greet');
    assert.deepEqual(greet.find(day => day.name === '元旦' && day.year === 2027), own);
    assert.equal(greet.find(day => day.name === '元旦' && day.year === 2028)!.silent, undefined);
    assert.equal(greet.find(day => day.name === '元旦' && day.year === 2028)!.midnight, true);
    const again = withFestivals(greet, now, 'notes');
    assert.equal(again.find(day => day.name === '元旦' && day.year === 2028)!.silent, true);
    assert.equal(again.find(day => day.name === '元旦' && day.year === 2028)!.midnight, undefined);
    const off = withFestivals(again, now, 'off');
    assert.deepEqual(off.filter(day => day.year! >= 2027), [own]);
});

test('关闭节日只撤销未来活动，保留已开始时段与作者安排', () => {
    const value = schedule(); const enabledAt = at('2026-10-01T12:00:00');
    withFestivalActivities(value, enabledAt, 'notes');
    const halloween = value.free.on!.find(item => item.date === '2026-10-31')!;
    assert.ok(halloween);
    const offAt = at('2026-10-31T20:00:00');
    withFestivalActivities(value, offAt, 'off');
    assert.ok(value.free.on!.some(item => JSON.stringify(item) === JSON.stringify(halloween)));
    assert.ok(value.free.on!.some(item => item.text === '作者的生日安排'));
    assert.ok(!value.free.on!.some(item => item.date === '2026-12-24'));
});

test('过去已生成的日历标记不因模式升级被改写，无来源的同名条目保守保留', () => {
    const first = withFestivals([], at('2026-01-01T00:00:00'), 'notes');
    const old = structuredClone(first.find(day => day.name === '元旦' && day.year === 2026)!);
    const later = withFestivals(first, at('2026-11-05T12:00:00'), 'greet');
    assert.deepEqual(later.find(day => day.name === '元旦' && day.year === 2026), old);
    const legacy: ImportantDay = { name: '平安夜', date: '12-24', year: 2027, ahead: 3, silent: true };
    assert.deepEqual(withFestivals([legacy], at('2026-11-05T12:00:00'), 'off'), [legacy]);
});
