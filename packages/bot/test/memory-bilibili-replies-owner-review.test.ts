import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BiliApiError, type BiliAccount, type ReplyItem } from '../src/bilibili/bilibili-account.ts';
import { createReplyWatcher } from '../src/bilibili/bilibili-replies.ts';
import { fileOps } from '../src/memory/json-file.ts';

const at = Date.parse('2026-11-05T12:00:00+08:00');
const item: ReplyItem = { id: '701', root: '700', parent: '700', aid: 1, title: '合成猫咪', uid: 456, name: '合成留言者', text: '这只猫咪看起来很开心', mine: '猫咪今天睡醒了', at: at - 1000 };
const turn = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 10; i++) await turn(); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(stage: 'account' | 'fetch' | 'compose' | 'post' | 'none', failure = false) {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-replies-core-owner-')), held = deferred<void>(), logs: string[] = [];
 let entered = false, accounts = 0, fetches = 0, models = 0, sends = 0;
 const pause = async (name: string) => { if (stage === name) { entered = true; await held.promise; if (failure) throw Error('SYNTHETIC_LATE_REPLY_FAILURE'); } };
 const account = { mid: 123, fetchReplies: async () => { fetches++; await pause('fetch'); return [item]; }, postReply: async () => { sends++; await pause('post'); return { rpid: '702' }; } } as unknown as BiliAccount;
 const options = { mode: 'on' as const, dir, userUid: 456, now: () => at, random: () => 0, log: (line: string) => logs.push(line),
  account: async () => { accounts++; await pause('account'); return account; }, compose: async () => { models++; await pause('compose'); return '它看起来确实挺开心'; } };
 const watcher = createReplyWatcher(options);
 return { watcher, options, dir, held, logs, counts: () => ({ accounts, fetches, models, sends }), entered: () => entered,
  state: () => { const path = join(dir, 'bilibili-replies.json'); return existsSync(path) ? readFileSync(path, 'utf8') : ''; },
  corpus: () => { const path = join(dir, 'bilibili-corpus.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8') : ''; },
  cleanup: async () => { held.resolve(); await watcher.stop(); await settle(); rmSync(dir, { recursive: true, force: true }); } };
}
async function entered(f: ReturnType<typeof fixture>) { for (let i = 0; i < 50 && !f.entered(); i++) await turn(); assert.ok(f.entered()); }

for (const stage of ['account', 'fetch', 'compose'] as const) test(`回复owner停止取消held ${stage}本地等待，晚成功不派后继/提交`, async () => {
 const f = fixture(stage);
 try {
  const running = f.watcher.tick(); await entered(f); const before = f.counts();
  await f.watcher.stop(); const state = f.state(), corpus = f.corpus(), logs = [...f.logs];
  f.held.resolve(); await running; await settle();
  assert.deepEqual(f.counts(), before); assert.equal(f.state(), state); assert.equal(f.corpus(), corpus); assert.deepEqual(f.logs, logs);
 } finally { await f.cleanup(); }
});

test('回复owner停止后晚模型失败不写失败日志或无回复语料', async () => {
 const f = fixture('compose', true);
 try { const running = f.watcher.tick(); await entered(f); await f.watcher.stop(); const logs = [...f.logs]; f.held.resolve(); await running; await settle(); assert.deepEqual(f.logs, logs); assert.equal(f.corpus(), ''); assert.equal(f.state(), ''); }
 finally { await f.cleanup(); }
});

test('已派postReply的ACK与本地语料收尾仍owned，停止不能提前完成', async () => {
 const f = fixture('post');
 try {
  const running = f.watcher.tick(); await entered(f); let drained = false; const drain = Promise.resolve(f.watcher.stop()).then(() => { drained = true; }); await settle();
  assert.equal(drained, false); assert.equal(JSON.parse(f.state()).handled.includes(item.id), true, '预留在派发之前已持久');
  f.held.resolve(); await drain; await running; assert.equal(f.counts().sends, 1); assert.match(f.corpus(), /"answered":"sent"/); assert.equal(JSON.parse(f.state()).failures, 0);
  const bytes = f.state(); await f.watcher.tick(); f.watcher.start(); await settle(); assert.equal(f.state(), bytes); assert.equal(f.counts().sends, 1);
 } finally { await f.cleanup(); }
});

test('已派postReply失败仍保真实失败状态和风险观察，停止后不重派', async () => {
 const f = fixture('post', true); let trips = 0;
 const watcher = createReplyWatcher({ ...f.options, risk: { halted: () => false, trip: async () => { trips++; } } });
 try { const running = watcher.tick(); await entered(f); const drain = watcher.stop(); f.held.resolve(); await drain; await running; assert.equal(JSON.parse(f.state()).failures, 1); assert.equal(f.counts().sends, 1); assert.equal(trips, 0, '普通传输错误不伪造B站风险'); assert.equal(f.corpus(), ''); }
 finally { await watcher.stop(); await f.cleanup(); }
});

test('停止永久拒新tick/start，不在微任务后重新开启', async () => {
 const f = fixture('none');
 try { await f.watcher.stop(); await f.watcher.tick(); f.watcher.start(); await settle(); assert.deepEqual(f.counts(), { accounts: 0, fetches: 0, models: 0, sends: 0 }); assert.equal(f.state(), ''); }
 finally { await f.cleanup(); }
});

test('正常确认的state/corpus跨新实例保留且不重复回复', async () => {
 const f = fixture('none');
 try { await f.watcher.tick(); await f.watcher.stop(); const state = f.state(), corpus = f.corpus(); assert.equal(f.counts().sends, 1); const next = createReplyWatcher(f.options); await next.tick(); await next.stop(); assert.equal(f.counts().sends, 1); assert.equal(f.state(), state); assert.equal(f.corpus(), corpus); }
 finally { await f.cleanup(); }
});

test('tick登记后微任务前停止不会派发账号来源', async () => {
 const f = fixture('none');
 try { const running = f.watcher.tick(); await f.watcher.stop(); await running; assert.deepEqual(f.counts(), { accounts: 0, fetches: 0, models: 0, sends: 0 }); assert.equal(f.state(), ''); }
 finally { await f.cleanup(); }
});

test('postReply公开回调同步stop再throw仍归当前owner，保真实失败收尾', async () => {
 const f = fixture('none'); let calls = 0, drain: Promise<void> | undefined;
 const account = { mid: 123, fetchReplies: async () => [item], postReply: () => { calls++; drain = watcher.stop(); throw Error('SYNTHETIC_SYNC_POST_FAILURE'); } } as unknown as BiliAccount;
 const watcher = createReplyWatcher({ ...f.options, account });
 try { await watcher.tick(); assert.ok(drain instanceof Promise); await drain; assert.equal(calls, 1); assert.equal(JSON.parse(f.state()).failures, 1); assert.equal(f.corpus(), ''); await watcher.tick(); assert.equal(calls, 1); }
 finally { await watcher.stop(); await f.cleanup(); }
});

test('停止期间已派回复返回风险只record持久观察，不新trip通知', async () => {
 const f = fixture('none'), held = deferred<void>(); let entered = false, records = 0, trips = 0;
 const account = { mid: 123, fetchReplies: async () => [item], postReply: async () => { entered = true; await held.promise; throw new BiliApiError('SYNTHETIC_RISK', -352); } } as unknown as BiliAccount;
 const watcher = createReplyWatcher({ ...f.options, account, risk: { halted: () => false, trip: async () => { trips++; }, record: async () => { records++; } } });
 try { const running = watcher.tick(); for (let i = 0; i < 50 && !entered; i++) await turn(); assert.ok(entered); const drain = watcher.stop(); held.resolve(); await drain; await running; assert.equal(records, 1); assert.equal(trips, 0); assert.equal(JSON.parse(f.state()).failures, 1); }
 finally { held.resolve(); await watcher.stop(); await f.cleanup(); }
});

test('已派回复成功后停止期间索引IO失败不被取消catch伪装成功', async () => {
 const f = fixture('post'), original = { ...fileOps };
 try {
  const running = f.watcher.tick(); await entered(f); const drain = f.watcher.stop();
  fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(Error('SYNTHETIC_REPLY_STATE_EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
  const rejected = Promise.all([assert.rejects(running), assert.rejects(drain)]); f.held.resolve(); await rejected;
  assert.equal(f.counts().sends, 1); assert.match(f.corpus(), /"answered":"sent"/); assert.equal(JSON.parse(f.state()).handled.includes(item.id), true);
 } finally { Object.assign(fileOps, original); f.held.resolve(); await f.watcher.stop().catch(() => {}); await settle(); rmSync(f.dir, { recursive: true, force: true }); }
});
