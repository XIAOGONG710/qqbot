import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { BiliApiError, type BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { createReplyWatcher, REPLY_DAY_MAX } from '../src/bilibili/bilibili-replies.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { formatDate } from '../src/life/schedule.ts';
const base = new Date(2026, 10, 5, 12).getTime();
function fixture(initial?: unknown) {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-reply-state-review-')), path = join(dir, 'bilibili-replies.json'); let clock = base, sends = 0, models = 0, fetches = 0, nonce = 1;
 if (initial !== undefined) writeFileSync(path, typeof initial === 'string' ? initial : JSON.stringify(initial));
 const logs: string[] = [], account = { mid: 123, fetchReplies: async () => { fetches++; return [{ id: String(nonce), root: '700', parent: '700', aid: 1, title: '合成猫咪', uid: 456 + nonce, name: '合成留言者', text: '猫咪看起来确实很开心', mine: '合成猫咪', at: clock }]; }, postReply: async () => { sends++; return { rpid: '800' }; } } as unknown as BiliAccount;
 const options = { mode: 'on' as const, dir, userUid: 999, now: () => clock, random: () => 0, log: (line: string) => logs.push(line), account, compose: async () => { models++; return '看起来确实挺开心'; } };
 return { dir, path, options, logs, read: () => JSON.parse(readFileSync(path, 'utf8')), counts: () => ({ sends, models, fetches }), next: () => { nonce++; clock += 10 * 60_000; }, advance: () => { clock += 20 * 60_000; }, setNow: (at: number) => { clock = at; }, cleanup: () => { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-reply-state-review-')); rmSync(dir, { recursive: true, force: true }); } };
}
test('畸形计数不被接受，不能用字符串加法绕过每日回复额度', async () => {
 const f = fixture({ version: 1, handled: [], day: formatDate(new Date(base)), count: 'not-a-number', perPerson: {} }); const holder: { watcher?: ReturnType<typeof createReplyWatcher> } = {};
 try { assert.throws(() => { holder.watcher = createReplyWatcher(f.options); }); assert.equal(f.counts().sends, 0); }
 finally { await holder.watcher?.stop(); f.cleanup(); }
});
test('完整已知schema坏字段保原拒构造，不隔离或猜空白', () => {
 const invalid: unknown[] = [
  { handled: [1] }, { handled: [null] }, { day: '2026-02-30' }, { day: '0099-2-01' }, { count: -1 }, { userCount: 1.5 }, { failures: Number.MAX_SAFE_INTEGER + 1 },
  { perPerson: [] }, { perPerson: { '456': '1' } }, { perPerson: { constructor: 1 } }, { perPerson: JSON.parse('{"__proto__":1}') },
  { nextPollAt: 'tomorrow' }, { nextReplyAt: 1.5 }, { pausedUntil: 8.64e15 }, { recent: [false] }, { version: 2 },
 ];
 for (const patch of invalid) {
  const f = fixture({ version: 1, handled: [], ...(patch as object) });
  try { const before = readFileSync(f.path, 'utf8'); assert.throws(() => createReplyWatcher(f.options)); assert.equal(readFileSync(f.path, 'utf8'), before); assert.deepEqual(readdirSync(f.dir), ['bilibili-replies.json']); assert.equal(f.counts().fetches, 0); }
  finally { f.cleanup(); }
 }
});
test('坏JSON保原拒启动，不quarantine后重建回复状态', () => {
 const f = fixture('{"version":1,"handled":');
 try { assert.throws(() => createReplyWatcher(f.options)); assert.equal(readFileSync(f.path, 'utf8'), '{"version":1,"handled":'); assert.deepEqual(readdirSync(f.dir), ['bilibili-replies.json']); }
 finally { f.cleanup(); }
});
test('合法最小旧v1及未知扩展保留，正常每日额度仍生效', async () => {
 const f = fixture({ version: 1, handled: [], syntheticExtension: { keep: true } }); const watcher = createReplyWatcher(f.options);
 try { for (let i = 0; i < 7; i++) { await watcher.tick(); f.next(); } assert.equal(f.counts().sends, REPLY_DAY_MAX); assert.equal(f.read().count, REPLY_DAY_MAX); assert.deepEqual(f.read().syntheticExtension, { keep: true }); }
 finally { await watcher.stop(); f.cleanup(); }
});
test('持久预留发布前失败不发送且不在RAM吞掉同条重试', async () => {
 const f = fixture(), watcher = createReplyWatcher(f.options), original = { ...fileOps };
 try {
  fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(Error('synthetic reservation EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
  await assert.rejects(watcher.tick()); assert.equal(f.counts().sends, 0); assert.equal(existsSync(f.path), false);
  Object.assign(fileOps, original); f.advance(); await watcher.tick(); assert.equal(f.counts().sends, 1); assert.deepEqual(f.read().handled, ['1']); assert.equal(f.read().count, 1);
 } finally { Object.assign(fileOps, original); await watcher.stop().catch(() => {}); f.cleanup(); }
});
test('预留rename后异常精确读回承认发布，再发送且不重复扣额', async () => {
 const f = fixture(), watcher = createReplyWatcher(f.options), original = { ...fileOps };
 try {
  fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); throw Object.assign(Error('synthetic published EIO'), { code: 'EIO' }); }) as typeof fileOps.renameSync;
  await watcher.tick(); Object.assign(fileOps, original); assert.equal(f.counts().sends, 1); assert.equal(f.read().count, 1); f.advance(); await watcher.tick(); assert.equal(f.counts().sends, 1);
 } finally { Object.assign(fileOps, original); await watcher.stop().catch(() => {}); f.cleanup(); }
});
test('已派失败状态持久失败保真实pending，恢复先flush再按暂停拒新发送', async () => {
 const f = fixture(), original = { ...fileOps }; let posts = 0;
 const account = { ...f.options.account, mid: 123, fetchReplies: f.options.account.fetchReplies.bind(f.options.account), postReply: async () => { posts++; fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(Error('synthetic post-failure state'), { code: 'EROFS' }); }) as typeof fileOps.renameSync; throw Error('synthetic remote failure'); } } as unknown as BiliAccount;
 const watcher = createReplyWatcher({ ...f.options, account });
 try { await assert.rejects(watcher.tick()); assert.equal(posts, 1); assert.equal(f.read().failures, undefined); Object.assign(fileOps, original); f.next(); await watcher.tick(); assert.equal(posts, 1); assert.equal(f.read().failures, 1); assert.ok(f.read().pausedUntil > base); }
 finally { Object.assign(fileOps, original); await watcher.stop().catch(() => {}); f.cleanup(); }
});

test('预留发布结果未知时不发送，fresh恢复只尊重已持久预留宁少不重', async () => {
 const f = fixture(), watcher = createReplyWatcher(f.options), original = { ...fileOps };
 try {
  fileOps.writeDelaysMs = [0]; fileOps.readDelaysMs = [0];
  fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); throw Object.assign(Error('synthetic rename unknown'), { code: 'EIO' }); }) as typeof fileOps.renameSync;
  fileOps.readFileSync = (() => { throw Object.assign(Error('synthetic readback unknown'), { code: 'EIO' }); }) as typeof fileOps.readFileSync;
  await assert.rejects(watcher.tick()); assert.equal(f.counts().sends, 0); await assert.rejects(watcher.tick()); assert.equal(f.counts().sends, 0);
  Object.assign(fileOps, original); f.advance(); await watcher.tick(); assert.equal(f.counts().sends, 0); assert.deepEqual(f.read().handled, ['1']); assert.equal(f.read().count, 1);
 } finally { Object.assign(fileOps, original); await watcher.stop().catch(() => {}); f.cleanup(); }
});
test('已派真实风险记录器失败也要尝试持久回复失败事实', async () => {
 const f = fixture();
 const account = { ...f.options.account, postReply: async () => { throw new BiliApiError('synthetic risk', -352); } } as unknown as BiliAccount;
 const watcher = createReplyWatcher({ ...f.options, account, risk: { halted: () => false, trip: async () => { throw Error('synthetic risk IO failure'); } } });
 try { await assert.rejects(watcher.tick()); assert.equal(f.read().failures, 1); assert.ok(f.read().pausedUntil > base); assert.deepEqual(f.read().handled, ['1']); }
 finally { await watcher.stop().catch(() => {}); f.cleanup(); }
});
test('安全极值/epoch0和低年份旧v1可读，未知扩展不猜迁移', async () => {
 for (const t of [0, new Date('0099-02-01T12:00:00Z').getTime()]) {
  const f = fixture({ version: 1, handled: ['already'], nextPollAt: t, nextReplyAt: t, pausedUntil: t, day: formatDate(new Date(t)), failures: 0, userCount: 0, perPerson: { '0': 0, '456': 1 }, recent: ['合成旧回复'] }); f.setNow(t);
  const watcher = createReplyWatcher(f.options);
  try { await watcher.tick(); assert.equal(f.counts().sends, 1); assert.equal(f.read().day, formatDate(new Date(t))); assert.ok(f.read().handled.includes('already')); }
  finally { await watcher.stop(); f.cleanup(); }
 }
});
test('随机数坏值或四位末年派生越界拒派并回退RAM，不伪消费回复', async () => {
 const f = fixture(); let random = Number.NaN;
 const watcher = createReplyWatcher({ ...f.options, random: () => random });
 try { await assert.rejects(watcher.tick()); assert.equal(f.counts().sends, 0); assert.equal(existsSync(f.path), false); random = 0; f.advance(); await watcher.tick(); assert.equal(f.counts().sends, 1); }
 finally { await watcher.stop().catch(() => {}); f.cleanup(); }
 const end = fixture(); end.setNow(new Date('9999-12-31T12:00:00Z').getTime()); const owner = createReplyWatcher(end.options);
 try { await assert.rejects(owner.tick()); assert.equal(end.counts().sends, 0); assert.equal(existsSync(end.path), false); }
 finally { await owner.stop().catch(() => {}); end.cleanup(); }
});
