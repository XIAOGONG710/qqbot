import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createPresence, pokeOutPlan, qzonePlan, type PresenceOptions } from '../src/social/presence.ts';
import { createVideoBrowsing, videoPlan, type VideoBrowsingOptions } from '../src/bilibili/bilibili.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { BiliApiError } from '../src/bilibili/bilibili-account.ts';
import type { InitiateOutcome } from '../src/social/responder.ts';
const schedule: Schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: {}, semester: { start: '2026-09-01', weeks: 52 },
 holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
function planned(plan: typeof qzonePlan) { for (let i = 0; i < 100; i++) { const d = new Date(2026, 10, 1 + i, 23); if (plan(formatDate(d), d.getDay() === 0 || d.getDay() === 6)) return d.getTime(); } throw Error('synthetic plan'); }
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(done => { release = done; }); return { promise, release }; }
const turn = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { assert.ok(Date.now() < end, 'synthetic timeout'); await turn(); } }
const temp = () => mkdtempSync(join(tmpdir(), 'qqbot-external-stop-'));
function clean(dir: string) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-external-stop-')); rmSync(dir, { recursive: true, force: true }); }
function presence(dir: string, patch: Partial<PresenceOptions> = {}) { return createPresence({ dir, schedule, now: () => planned(qzonePlan), log() {}, likeTargets: [], transport: {},
 flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'on', qzoneVisibility: 'friends' }, ...patch }); }
function browsing(dir: string, patch: Partial<VideoBrowsingOptions> = {}) {
 const now = planned(videoPlan); writeFileSync(join(dir, 'bilibili.json'), JSON.stringify({ version: 1, seen: [], shares: [], cache: { at: now, list: [
  { bvid: 'BV1abcdefghj', aid: 1, title: '合成猫咪', desc: '', owner: '合成作者', category: '喵星人', duration: 60, views: 1000, likes: 10, link: 'https://www.bilibili.com/video/BV1abcdefghj' }] } }));
 return createVideoBrowsing({ dir, schedule, now: () => now, log() {}, mode: 'on', target: { qq: 10001, name: '合成联系人' },
  fetch: async () => ({ ok: true, status: 200, text: async () => '{"code":0,"data":{"replies":[]}}' }),
  initiate: async req => { req.commit(['合成感想']); return { result: 'sent', parts: ['合成感想'], messageIds: [1] }; }, sendLink: async () => {}, ...patch });
}

test('presence纯compose在stop时取消，晚模型不发说说；idle/repeat stop保持同步语义', async () => {
 const dir = temp(), held = gate<{ text: string; withPhoto: boolean }>(); let entered = false, sends = 0;
 const p = presence(dir, { composeQzone: async () => { entered = true; return held.promise; }, transport: { postQzone: async () => { sends++; return 'synthetic'; } } });
 try { const job = p.tick(); await until(() => entered); const stopped = p.stop();
  await Promise.race([Promise.resolve(stopped), new Promise((_, reject) => setTimeout(() => reject(Error('stop blocked on pure compose')), 300))]);
  held.release({ text: '合成晚模型', withPhoto: false }); await job; assert.equal(sends, 0); await p.tick(); p.start(); p.reapply(); assert.equal(sends, 0);
  const idle = presence(dir); assert.equal(idle.stop(), undefined); assert.equal(idle.stop(), undefined);
 } finally { held.release({ text: '合成清理', withPhoto: false }); await p.stop(); clean(dir); }
});

test('presence已派post ACK及本地事实属于stop drain，之后不启动browse', async () => {
 const dir = temp(), held = gate<string>(); let entered = false, reads = 0;
 const p = presence(dir, { composeQzone: async () => ({ text: '合成已派说说', withPhoto: false }),
  flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'on', qzoneVisibility: 'friends', qzoneBrowse: 'on' },
  transport: { postQzone: async () => { entered = true; return held.promise; }, readQzoneFeed: async () => { reads++; return undefined; } } });
 try { const job = p.tick(); await until(() => entered); const drain = p.stop(); assert.ok(drain instanceof Promise); assert.equal(p.stop(), drain);
  let done = false; void drain.then(() => { done = true; }); await turn(); assert.equal(done, false);
  held.release('synthetic-ACK'); await drain; await job; const state = JSON.parse(readFileSync(join(dir, 'presence.json'), 'utf8'));
  assert.equal(state.qzone[0].tid, 'synthetic-ACK'); assert.equal(reads, 0);
 } finally { held.release('synthetic-cleanup'); await p.stop(); clean(dir); }
});

test('B站链接已派send及history收尾属于外层drain，停止后不再tick/start', async () => {
 const dir = temp(), held = gate<void>(); let entered = false, confirmed = 0; let signal: AbortSignal | undefined;
 const b = browsing(dir, { sendLink: async (_video, active) => { signal = active; entered = true; await held.promise; confirmed++; writeFileSync(join(dir, 'history-ACK.txt'), 'synthetic confirmed link'); } });
 try { const job = b.tick(); await until(() => entered); const drain = b.stop(); assert.ok(drain instanceof Promise); assert.equal(b.stop(), drain);
  let done = false; void drain.then(() => { done = true; }); await turn(); assert.equal(done, false);
  assert.equal(signal!.aborted, true);
  held.release(); await drain; await job; assert.equal(confirmed, 1); assert.equal(readFileSync(join(dir, 'history-ACK.txt'), 'utf8'), 'synthetic confirmed link');
  await b.tick(); b.start(); await turn(); assert.equal(confirmed, 1);
 } finally { held.release(); await b.stop(); clean(dir); }
});

test('presence已派戳一戳ACK后的history和状态都在drain内', async () => {
 const dir = temp(), held = gate<void>(); let entered = false, recorded = 0;
 const date = new Date(planned(pokeOutPlan)); date.setHours(21, 30, 0, 0);
 const p = presence(dir, { now: () => date.getTime(), flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', pokeOut: true },
  pokeTargets: [10001], transport: { pokeFriend: async () => { entered = true; await held.promise; } }, recordPokeOut: () => { recorded++; } });
 try { const job = p.tick(); await until(() => entered); const drain = p.stop(); assert.ok(drain instanceof Promise);
  held.release(); await drain; await job; assert.equal(recorded, 1); assert.equal(JSON.parse(readFileSync(join(dir, 'presence.json'), 'utf8')).pokesOut.length, 1);
 } finally { held.release(); await p.stop(); clean(dir); }
});

test('B站纯模型尚未commit时stop立即取消，晚sent也不再发链接或写commit', async () => {
 const dir = temp(), held = gate<InitiateOutcome>(); let entered = false, links = 0; let signal: AbortSignal | undefined;
 const b = browsing(dir, { initiate: async request => { entered = true; signal = request.signal; return held.promise; }, sendLink: async () => { links++; } });
 try { const job = b.tick(); await until(() => entered); const drain = b.stop();
  await Promise.race([Promise.resolve(drain), new Promise((_, reject) => setTimeout(() => reject(Error('pure model held stop')), 300))]);
  assert.equal(signal!.aborted, true); held.release({ result: 'sent', parts: ['合成晚模型'], messageIds: [2] }); await job; await turn();
  assert.equal(links, 0); assert.equal(JSON.parse(readFileSync(join(dir, 'bilibili.json'), 'utf8')).shares.length, 0);
 } finally { held.release({ result: 'skipped', reason: '合成清理' }); await b.stop(); clean(dir); }
});

const account = (patch: Record<string, unknown> = {}): BiliAccount => ({ search: async () => [], subtitle: async () => ({ status: 'none' }), ...patch }) as unknown as BiliAccount;
test('B站已派评论停机后返回风险失败，仍保存暂停且只记录风险不新发私信', async () => {
 const dir = temp(), held = gate<void>(); let entered = false, recorded = 0, alerts = 0;
 const b = browsing(dir, { account: account({ postComment: async () => { entered = true; await held.promise; throw new BiliApiError('synthetic risk', -352); } }),
  risk: { halted: () => false, trip: async () => { alerts++; }, record: async () => { recorded++; } },
  comment: { mode: 'on', at: { name: '合成联系人', uid: 10002 }, compose: async () => '合成评论' } });
 try { const job = b.tick(); await until(() => entered); const drain = b.stop(); held.release(); await drain; await job;
  assert.equal(recorded, 1); assert.equal(alerts, 0); assert.equal(JSON.parse(readFileSync(join(dir, 'bilibili.json'), 'utf8')).commentFailures, 1);
 } finally { held.release(); await b.stop(); clean(dir); }
});
test('B站已派DM等ACK和recordDm后结束drain，不再启动QQ提醒', async () => {
 const dir = temp(), held = gate<void>(); let entered = false, recorded = 0, generations = 0;
 const b = browsing(dir, { account: account({ sendDm: async () => { entered = true; await held.promise; } }), dm: { mode: 'on', uid: 10002 },
  initiate: async () => { generations++; return { result: 'dryRun', parts: ['合成私信'] }; }, recordDm: () => { recorded++; } });
 try { const job = b.tick(); await until(() => entered); const drain = b.stop(); assert.ok(drain instanceof Promise); let done = false; void drain.then(() => { done = true; }); await turn(); assert.equal(done, false);
  held.release(); await drain; await job; const state = JSON.parse(readFileSync(join(dir, 'bilibili.json'), 'utf8'));
  assert.equal(recorded, 1); assert.equal(generations, 1); assert.equal(state.shares[0].via, 'dm'); assert.ok(state.dmPending);
 } finally { held.release(); await b.stop(); clean(dir); }
});

test('B站已派评论ACK保rpid，stop后不再做新动作', async () => {
 const dir = temp(), held = gate<{ rpid: string }>(); let entered = false;
 const b = browsing(dir, { account: account({ postComment: async () => { entered = true; return held.promise; } }),
  comment: { mode: 'on', at: { name: '合成联系人', uid: 10002 }, compose: async () => '合成评论' } });
 try { const job = b.tick(); await until(() => entered); const drain = b.stop(); assert.ok(drain instanceof Promise);
  held.release({ rpid: 'synthetic-rpid' }); await drain; await job;
  assert.equal(JSON.parse(readFileSync(join(dir, 'bilibili.json'), 'utf8')).comments[0].rpid, 'synthetic-rpid');
 } finally { held.release({ rpid: 'synthetic-cleanup' }); await b.stop(); clean(dir); }
});

test('presence已派在线状态保ACK且不启动下一项；纯feed读取消后晚结果不落盘', async () => {
 const dir = temp(), held = gate<void>(); let entered = false, composed = 0;
 const p = presence(dir, { flags: { onlineStatus: true, profileLikes: false, signature: 'off', qzone: 'on', qzoneVisibility: 'friends' },
  transport: { setOnlineStatus: async () => { entered = true; await held.promise; } }, composeQzone: async () => { composed++; return undefined; } });
 try { const job = p.tick(); await until(() => entered); const drain = p.stop(); assert.ok(drain instanceof Promise); held.release(); await drain; await job;
  assert.ok(JSON.parse(readFileSync(join(dir, 'presence.json'), 'utf8')).status); assert.equal(composed, 0);
 } finally { held.release(); await p.stop(); clean(dir); }
 const readDir = temp(), feed = gate<undefined>(); let reading = false;
 const reader = presence(readDir, { now: () => new Date(2026, 10, 5, 12).getTime(), flags: { onlineStatus: false, profileLikes: false, signature: 'off', qzone: 'off', qzoneVisibility: 'friends', qzoneBrowse: 'on' },
  transport: { readQzoneFeed: async () => { reading = true; return feed.promise; } } });
 try { const job = reader.tick(); await until(() => reading); await reader.stop(); const before = readFileSync(join(readDir, 'presence.json'), 'utf8');
  feed.release(undefined); await job; await turn(); assert.equal(readFileSync(join(readDir, 'presence.json'), 'utf8'), before);
 } finally { feed.release(undefined); await reader.stop(); clean(readDir); }
});
