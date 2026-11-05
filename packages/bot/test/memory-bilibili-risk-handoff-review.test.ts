import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createVideoBrowsing, COMMENT_HIDDEN_PAUSE_MS, type VideoBrowsing } from '../src/bilibili/bilibili.ts';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import type { RiskEvent } from '../src/bilibili/bilibili-risk.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';

const at = new Date(2026, 10, 5, 12).getTime();
const schedule: Schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: {}, semester: { start: '2026-09-01', weeks: 52 }, holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
const turn = () => new Promise<void>(done => setImmediate(done));

for (const stopAtHandoff of [true, false]) test(`评论确认两次hidden后${stopAtHandoff ? '日志同步stop仅record并等待持久观察' : '仍活跃则正常trip通知'}`, async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-risk-handoff-')), path = join(dir, 'bilibili.json');
 writeFileSync(path, JSON.stringify({ version: 1, seen: [], shares: [], attemptDay: formatDate(new Date(at)), comments: [{ at: at - 30 * 60_000, bvid: 'BV1abcdefghj', aid: 1, rpid: '701', text: '合成已发评论', misses: 1, checkAt: at - 1 }] }));
 let browser!: VideoBrowsing, stopping: Promise<void> | undefined, release!: () => void, visibleCalls = 0, successorCalls = 0;
 const records: RiskEvent[] = [], trips: RiskEvent[] = [], held = new Promise<void>(done => { release = done; });
 const account = { commentVisible: async () => { visibleCalls++; return false; } } as unknown as BiliAccount;
 browser = createVideoBrowsing({ dir, schedule, now: () => at, mode: 'on', target: { qq: 10001, name: '合成联系人' }, account,
  log: message => { if (stopAtHandoff && message.includes('两次都没在公开的最新评论里找到')) { stopping = browser.stop(); } },
  risk: { halted: () => false, record: async event => { records.push(event); await held; writeFileSync(join(dir, 'synthetic-risk-record.txt'), JSON.stringify(event)); }, trip: async event => { trips.push(event); } },
  fetch: async () => { successorCalls++; throw Error('unexpected synthetic fetch'); },
  initiate: async () => { successorCalls++; return { result: 'skipped', reason: 'synthetic no new work' }; }, sendLink: async () => { successorCalls++; },
 });
 try {
  const job = browser.tick();
  for (let i = 0; i < 50 && !(stopAtHandoff ? records.length : trips.length); i++) await turn();
  assert.equal(visibleCalls, 1); assert.equal(records.length, stopAtHandoff ? 1 : 0); assert.equal(trips.length, stopAtHandoff ? 0 : 1);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.comments[0].visible, false); assert.equal(state.comments[0].checkAt, undefined); assert.equal(state.commentPausedUntil, at + COMMENT_HIDDEN_PAUSE_MS);
  if (stopAtHandoff) {
   assert.ok(stopping instanceof Promise); let drained = false; void stopping.then(() => { drained = true; }); await turn(); assert.equal(drained, false, '已确认风险持久观察仍是当前owner收尾');
   release(); await stopping; assert.equal(JSON.parse(readFileSync(join(dir, 'synthetic-risk-record.txt'), 'utf8')).wanted, '合成已发评论');
  }
  await job; assert.equal(successorCalls, 0);
 } finally { release(); await browser.stop(); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-risk-handoff-')); rmSync(dir, { recursive: true, force: true }); }
});
