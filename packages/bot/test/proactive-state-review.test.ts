import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseExtraction, partText, parseDay, firstAsk, type FollowUp } from '../src/proactive/follow-ups.ts';
import { emptyProactiveState, readProactiveState, validProactiveState } from '../src/proactive/proactive-state.ts';

test('跟进提取错误不回显模型正文，错误顶层结构不能当已完成空提取', () => {
 for (const text of ['PRIVATE_MODEL_MARKER', '{"PRIVATE_MODEL_MARKER":', '{}', '{"add":"PRIVATE_MODEL_MARKER","resolved":[]}']) {
  assert.throws(() => parseExtraction(text), error => error instanceof Error && !error.message.includes('PRIVATE_MODEL_MARKER'));
 }
});

test('畸形提取项不拖垮合法项，日历真实、继承时段键按未知回退', () => {
 const value = { add: [null, 5, [], { what: '坏日期', date: '2026-02-30', time: 'morning' },
  { what: '合成面试', date: '0000-02-29', time: 'constructor' }, { what: '合成考试', date: '0100-03-01', time: 'toString' }], resolved: ['f-1', 3] };
 assert.deepEqual(parseExtraction(JSON.stringify(value)), { add: [
  { what: '合成面试', date: '0000-02-29', time: 'afternoon' }, { what: '合成考试', date: '0100-03-01', time: 'afternoon' },
 ], resolved: ['f-1'] });
 assert.equal(partText('constructor'), 'constructor');
 assert.throws(() => parseDay('2026-02-30'), RangeError);
});

test('纯窗口计算保留数学范围，合法现代/低年跟进保持原来的两小时规则', () => {
 const item = (date: string, time: string): FollowUp => ({ id: 'f-synthetic', what: '合成面试', date, time, episode: 'ep-0' });
 assert.equal(new Date(firstAsk(item('9999-12-31', '23:30'))!).getFullYear(), 10000);
 for (const date of ['0099-11-05', '2026-11-05']) assert.equal(firstAsk(item(date, '14:00')), new Date(`${date}T16:00:00`).getTime());
 assert.equal(firstAsk(item('2026-11-05', 'evening')), undefined);
});

test('主动状态结果必须为字符串枚举，畸形对象返回false且坏文件保留', () => {
 const record = { id: '2026-11-05:morning', occasion: 'morning', at: '2026-11-05T09:00:00Z', plannedAt: '2026-11-05T09:00:00Z', result: 'sent' };
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-proactive-review-')); const path = join(dir, 'synthetic.json');
 try {
  for (const result of [['sent'], { toString: 1, valueOf: 1 }, null]) {
   const state = { ...emptyProactiveState(), records: [{ ...record, result }] };
   assert.equal(validProactiveState(state), false);
   const raw = JSON.stringify(state); writeFileSync(path, raw); assert.throws(() => readProactiveState(path)); assert.equal(readFileSync(path, 'utf8'), raw);
  }
  const legacy = { records: [record], extension: { keep: true } }; const raw = JSON.stringify(legacy); writeFileSync(path, raw);
  assert.equal(validProactiveState(readProactiveState(path)), true); assert.equal(readFileSync(path, 'utf8'), raw);
  assert.deepEqual((readProactiveState(path) as unknown as typeof legacy).extension, { keep: true });
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
