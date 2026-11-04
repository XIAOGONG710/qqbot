import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDate } from '../src/local-date.ts';
import { weatherFetcher } from '../src/world/weather.ts';

test('越界或无效天气刷新时钟保留已有缓存且不泄漏缓存内容，恢复后可重试', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-weather-date-'));
 try {
  const raw = JSON.stringify({ since: '2026-11-04', fetchedAt: '2026-11-04T12:00:00.000Z',
   hours: { '2026-11-05T00': { t: 17.123456, p: 0, c: 2 } } });
  for (const place of ['jinan', 'qingdao']) writeFileSync(join(dir, `${place}.json`), raw);
  let time = 0;
  const logs: string[] = [];
  const options = { dir, now: () => time, log: (message: string) => logs.push(message), provider: {
   id: 'synthetic', fetchHourly: async () => ({ '2026-11-05T00': { t: 20, p: 0, c: 2 } }),
  } };
  const fetcher = weatherFetcher(options);
  for (const invalid of [localDate(10000, 0, 2, 12), localDate(-1, 11, 30, 12), new Date(NaN),
   // 本地0000年仍可能编码成UTC负年；两种年界都必须合法。
   localDate(0, 0, 1, 1), new Date('9999-12-31T23:00:00Z')]) {
   if (Number.isFinite(invalid.getTime()) && invalid.getFullYear() >= 0 && invalid.getFullYear() <= 9999
    && /^\d{4}-/.test(invalid.toISOString())) continue;
   time = invalid.getTime();
   await fetcher.refresh();
   for (const place of ['jinan', 'qingdao']) assert.equal(readFileSync(join(dir, `${place}.json`), 'utf8'), raw);
   assert.equal(weatherFetcher(options).status().places.jinan.hours, 1);
   assert.ok(fetcher.status().places.jinan.error);
   const age = fetcher.status().places.jinan.ageMs;
   assert.ok(age === undefined || Number.isFinite(age), '坏时钟不应使公开状态带有 NaN 年龄');
  }
  assert.ok(logs.length > 0);
  assert.ok(logs.every(message => !message.includes('17.123456') && !message.includes(raw)));
  time = localDate(2026, 10, 5, 12).getTime();
  await fetcher.refresh();
  assert.equal(fetcher.status().places.jinan.error, undefined);
  assert.equal(weatherFetcher(options).status().places.jinan.error, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, 'jinan.json'), 'utf8')).fetchedAt, new Date(time).toISOString());
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('没有天气缓存时坏时钟不创建文件，正常四位年时钟恢复后能够刷新', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-weather-date-empty-'));
 try {
  let time = localDate(10000, 0, 2, 12).getTime();
  const fetcher = weatherFetcher({ dir, now: () => time, log: () => {}, provider: {
   id: 'synthetic', fetchHourly: async () => ({ '2026-11-05T00': { t: 20, p: 0, c: 2 } }),
  } });
  for (const invalid of [time, NaN]) {
   time = invalid;
   await fetcher.refresh();
   for (const place of ['jinan', 'qingdao']) assert.equal(existsSync(join(dir, `${place}.json`)), false);
   assert.equal(fetcher.status().places.jinan.errorAt, undefined);
   assert.ok(fetcher.status().places.jinan.error);
  }
  time = localDate(2026, 10, 5, 12).getTime();
  await fetcher.refresh();
  assert.equal(fetcher.status().places.jinan.error, undefined);
  assert.equal(fetcher.status().places.jinan.since, '2026-11-06');
  assert.equal(existsSync(join(dir, 'jinan.json')), true);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
