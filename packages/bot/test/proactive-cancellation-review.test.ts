import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponder, type InitiateRequest, type ResponderDeps } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import type { StoredMessage } from '../src/memory/history.ts';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (signal: AbortSignal, commit: () => void = () => {}): InitiateRequest & { signal: AbortSignal } => ({ signal, label: '合成主动', note: '合成', topic: '合成', maxBubbles: 3, dryRun: false, commit });
async function bounded<T>(task: Promise<T>): Promise<T | 'HUNG'> {
 let timer: ReturnType<typeof setTimeout>;
 try { return await Promise.race([task, new Promise<'HUNG'>(resolve => { timer = setTimeout(() => resolve('HUNG'), 150); })]); }
 finally { clearTimeout(timer!); }
}
function fixture(over: Partial<ResponderDeps> = {}) {
 const clock = new VirtualClock(new Date('2026-11-05T12:00:00Z')); const stored: StoredMessage[] = []; const sent: string[] = [];
 const deps: ResponderDeps = { userId: 1, history: { load: () => [...stored], append: (_id, message) => { stored.push(message); } },
  buildPrompt: chat => ({ messages: chat.map(message => ({ role: message.role, content: message.content })), activatedWorldInfo: [] }),
  generate: async () => '第一句\n第二句', clean: text => text, send: async (_id, text) => { sent.push(text); return sent.length; }, log: () => {},
  now: clock.now, waitUntil: clock.waitUntil, sleep: ms => clock.waitUntil(clock.now() + ms, new AbortController().signal), settle: { quietMs: 0, maxMs: 0 }, ...over };
 return { clock, stored, sent, responder: createResponder(deps) };
}

test('单次主动预取消及在途生成取消不提交，迟到结果丢弃而普通回复仍可用', async () => {
 let release!: (value: string) => void; let calls = 0; let commits = 0;
 const f = fixture({ generate: async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : '普通回复' });
 const pre = new AbortController(); pre.abort();
 try {
  const preResult = await bounded(f.responder.initiate(request(pre.signal)));
  assert.notEqual(preResult, 'HUNG'); assert.equal((preResult as { result: string }).result, 'skipped'); assert.equal(calls, 0);
  const stop = new AbortController(); const task = f.responder.initiate(request(stop.signal, () => { commits++; })); await tick(); stop.abort(new Error('PRIVATE_CANCEL_REASON'));
  const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'skipped');
  f.responder.receive('普通问题', 9, new Date(f.clock.now())); await f.responder.whenIdle(); assert.deepEqual(f.sent, ['普通回复']);
  release('迟到主动'); await tick(); assert.equal(commits, 0); assert.deepEqual(f.sent, ['普通回复']);
 } finally { release?.('cleanup'); f.responder.stop(); }
});

test('commit后打字等待期间取消只取消主动，commit一次且不发消息', async () => {
 let commits = 0;
 const f = fixture({ timing: { whenSeen: (_history, now) => ({ at: now, reason: 'synthetic' }), typingMs: () => 5000, skip: () => undefined } });
 const stop = new AbortController();
 try {
  const task = f.responder.initiate(request(stop.signal, () => { commits++; })); await tick(); assert.equal(commits, 1); assert.ok(f.clock.nextTimer());
  stop.abort(); const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'skipped');
  assert.equal(commits, 1); assert.deepEqual(f.sent, []); f.clock.advance(10_000); f.clock.advanceTo(f.clock.now()); await tick(); assert.deepEqual(f.sent, []);
 } finally { f.clock.advance(20_000); f.clock.advanceTo(f.clock.now()); f.responder.stop(); }
});

test('多气泡第一条已发后取消，保留确认历史但不发剩余气泡', async () => {
 const f = fixture(); const stop = new AbortController();
 try {
  const task = f.responder.initiate(request(stop.signal)); await tick(); assert.deepEqual(f.sent, ['第一句']); stop.abort();
  const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'sent');
  assert.deepEqual(f.stored.map(message => [message.messageId, message.content]), [[1, '第一句']]);
  f.clock.advance(10_000); f.clock.advanceTo(f.clock.now()); await tick(); assert.deepEqual(f.sent, ['第一句']);
 } finally { f.clock.advance(20_000); f.clock.advanceTo(f.clock.now()); f.responder.stop(); }
});

test('传输已开始时取消，晚确认仍记事实且不启动下一条', async () => {
 let release!: (id: number) => void; const f = fixture({ send: async () => new Promise(resolve => { release = resolve; }) }); const stop = new AbortController();
 try {
  const task = f.responder.initiate(request(stop.signal)); await tick(); stop.abort(); release(71); await tick();
  if (f.clock.nextTimer() !== undefined) { f.clock.advanceTo(f.clock.nextTimer()!); await tick(); }
  const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'sent');
  assert.deepEqual(f.stored.map(message => [message.messageId, message.content]), [[71, '第一句']]);
 } finally { release?.(72); f.responder.stop(); }
});

test('提示构建和审稿中取消不会提交或发送迟到结果', async () => {
 for (const phase of ['prompt', 'review']) {
  let release!: () => void; let commits = 0;
  const prompt = { messages: [], activatedWorldInfo: [] };
  const f = fixture(phase === 'prompt'
   ? { buildPrompt: () => new Promise(resolve => { release = () => resolve(prompt); }) }
   : { review: () => new Promise(resolve => { release = () => resolve('迟到审稿'); }) });
  const stop = new AbortController();
  try {
   const task = f.responder.initiate(request(stop.signal, () => { commits++; })); await tick(); stop.abort();
   const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'skipped');
   release(); await tick(); assert.equal(commits, 0); assert.deepEqual(f.sent, []);
  } finally { release?.(); f.responder.stop(); }
 }
});

test('错字已确认但尚未撤回时取消，保存实际错字且不撤回或补发', async () => {
 let recalls = 0;
 const f = fixture({ generate: async () => '正确一句', decorate: () => ({ parts: ['正确一句'], recall: { index: 0, wrong: '实际错字', fix: '*正确一句', afterMs: 1000 } }), recallOwn: async () => { recalls++; } });
 const stop = new AbortController();
 try {
  const task = f.responder.initiate(request(stop.signal)); await tick(); assert.deepEqual(f.sent, ['实际错字']); stop.abort();
  const result = await bounded(task); assert.notEqual(result, 'HUNG'); assert.equal((result as { result: string }).result, 'sent');
  assert.equal(recalls, 0); assert.deepEqual(f.stored.map(message => message.content), ['实际错字']);
 } finally { f.clock.advance(10_000); f.clock.advanceTo(f.clock.now()); f.responder.stop(); }
});
