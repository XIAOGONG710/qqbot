import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clarity, lastTouched, lastTouchedDay } from '../src/memory/fading.ts';
import { localDate } from '../src/local-date.ts';
import { civilDayInWindow, civilDayNumber, providerTime } from '../src/memory/civil-time.ts';

test('Apia缺失的文档日期不滚到次日，日记8天与阶段15天正常变淡', () => {
 const previous = process.env.TZ; process.env.TZ = 'Pacific/Apia';
 try { const fact = { id: 'synthetic', text: '合成记忆' };
  assert.equal(clarity({ ...fact, document_id: 'diary:2011-12-30' }, { now: localDate(2012, 0, 7, 12), heard: '', ignore: [] }), 'vague');
  assert.equal(clarity({ ...fact, document_id: 'phase:合成:2011-12-30' }, { now: localDate(2012, 0, 14, 12), heard: '', ignore: [] }), 'vague');
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('民用日窗口保留Apia缺日身份，午夜exclusive与02点end兼容', () => {
 const previous = process.env.TZ; process.env.TZ = 'Pacific/Apia';
 try { const missing = civilDayNumber('2011-12-30')!, next = civilDayNumber('2011-12-31')!;
  assert.equal(next - missing, 1); assert.equal(civilDayInWindow(missing, { start: localDate(2011, 11, 31), end: localDate(2012, 0, 1) }), false);
  assert.equal(civilDayInWindow(missing, { start: localDate(2011, 11, 29), end: localDate(2011, 11, 31) }), true);
  assert.equal(civilDayInWindow(next, { start: localDate(2011, 11, 29), end: localDate(2011, 11, 31) }), false);
  assert.equal(civilDayInWindow(next, { start: localDate(2011, 11, 29), end: localDate(2011, 11, 31, 2) }), true);
  assert.equal(civilDayInWindow(next, { start: new Date(NaN), end: localDate(2012, 0, 1) }), false);
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('合法低年闰日/跨年周末及epoch零日按民用日计算，lastTouched兼容旧Date', () => {
 assert.equal(civilDayNumber('0000-03-01')! - civilDayNumber('0000-02-28')!, 2);
 assert.equal(civilDayNumber('0099-12-31')! + 1, civilDayNumber('0100-01-01'));
 const week = { id: 'synthetic', text: '合成周记', document_id: 'week:0099-12-28' };
 assert.equal(lastTouchedDay(week), civilDayNumber('0100-01-03'));
 assert.equal(lastTouched(week)!.getFullYear(), 100); assert.equal(lastTouched(week)!.getDate(), 3);
 assert.equal(lastTouchedDay({ ...week, document_id: 'diary:1970-01-01' }), 0);
 assert.equal(clarity({ ...week, document_id: 'diary:1970-01-01' }, { now: localDate(1970, 0, 9), heard: '', ignore: [] }), 'vague');
 assert.equal(civilDayNumber('0100-02-29'), undefined); assert.equal(civilDayNumber('2026-02-30'), undefined);
});

test('DST23小时与25小时日不改变8个civil日后的模糊边界', () => {
 const previous = process.env.TZ; process.env.TZ = 'America/New_York';
 try { for (const [start, end] of [['2026-03-07', localDate(2026, 2, 15, 12)], ['2026-10-31', localDate(2026, 10, 8, 12)]] as const)
  assert.equal(clarity({ id: 'synthetic', text: '合成日记', document_id: `diary:${start}` }, { now: end, heard: '', ignore: [] }), 'vague');
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('供应商解析保留合法RFC/空格/日期/offset/低年，坏ISO日历前缀不滚动', () => {
 for (const value of ['Wed, 05 Nov 2025 12:00:00 GMT', '2026-11-05 12:00:00Z', '2026-11-05', '0099-01-01T12:00:00+08:00', '0000-02-29T12:00:00Z'])
  assert.equal(providerTime(value), Date.parse(value));
 for (const value of ['2026-02-30', '2026-02-30T12:00:00Z', '2026-02-30t12:00:00z', ' 2026-02-30 ', '2026-02-30Z', '2026-02-30 GMT', '2026-02-30UTC', '0100-02-29T12:00:00Z', 'not-a-date', null, undefined])
  assert.equal(providerTime(value), undefined);
 const fact = { id: 'synthetic', text: '合成记忆', occurred_start: '2026-02-30T12:00:00Z', mentioned_at: '2026-02-20T12:00:00Z' };
 assert.equal(lastTouchedDay(fact), civilDayNumber(new Date(fact.mentioned_at)));
 assert.equal(lastTouchedDay({ id: 'synthetic', text: '无日期' }), undefined);
 assert.equal(clarity({ id: 'synthetic', text: '无日期' }, { now: new Date(), heard: '', ignore: [] }), 'lasting');
});
