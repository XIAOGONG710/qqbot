import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoShelf } from '../src/vision/photos.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { PHOTO_INDEX_LOCK_FILE, PhotoIndexLockError, withPhotoIndexLock } from '../src/vision/photo-index-lock.ts';

const clock = () => new Date('2026-11-05T12:00:00Z');
const CHILD_LIMIT_MS = 15_000;
type Command = { id: number; op: string; source?: string; photo?: string; times?: number; phase?: string; checkpoint?: string };
type Reply = { id?: number; ready?: boolean; value?: unknown; error?: string };
function isBusy(error: unknown): boolean {
 let current = error;
 for (let i = 0; i < 6 && current instanceof Error; i++, current = current.cause) {
  if (current instanceof PhotoIndexLockError) return current.retryable;
 }
 return false;
}

if (process.env.QQBOT_PHOTO_CONCURRENCY_CHILD === '1') {
 const root = process.env.QQBOT_PHOTO_CONCURRENCY_ROOT!;
 const shelf = photoShelf({ dir: root, log: () => {}, now: clock });
 const originalRename = fileOps.renameSync;
 fileOps.writeDelaysMs = [0];
 process.on('message', async (message: Command) => {
  try {
   let value: unknown;
   if (message.phase) {
    const pause = () => {
     writeFileSync(message.checkpoint!, 'ready');
     // The parent kills this process at a real JSON publication boundary. Hard bounded even if its test fails.
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
     throw new Error('fault checkpoint expired');
    };
    fileOps.renameSync = ((from, to) => {
     if (String(to) !== join(root, 'index.json')) return originalRename(from, to);
     if (message.phase === 'before') pause();
     if (message.phase === 'fail-before') throw Object.assign(new Error('synthetic read-only'), { code: 'EROFS' });
     originalRename(from, to);
     if (message.phase === 'after') pause();
     if (message.phase === 'fail-after') throw Object.assign(new Error('synthetic post-rename failure'), { code: 'EIO' });
    }) as typeof fileOps.renameSync;
   }
   const retryBusy = async <T>(work: () => T): Promise<T> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
     try { return work(); }
     catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
     }
    }
   };
   if (message.op === 'hold') {
    const db = new DatabaseSync(join(root, PHOTO_INDEX_LOCK_FILE));
    try { db.exec('BEGIN IMMEDIATE'); writeFileSync(message.checkpoint!, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000); }
    finally { db.exec('ROLLBACK'); db.close(); }
    value = true;
   }
   else if (message.op === 'add') value = await retryBusy(() => shelf.add(message.source!, 'cat', '合成照片'));
   else if (message.op === 'used') { for (let i = 0; i < (message.times ?? 1); i++) await retryBusy(() => shelf.used(message.photo!)); value = true; }
   else if (message.op === 'remove') value = await retryBusy(() => shelf.remove(message.photo!));
   else if (message.op === 'list') value = shelf.list();
   else throw new Error('unknown synthetic operation');
   process.send!({ id: message.id, value } satisfies Reply);
  } catch (error) { process.send!({ id: message.id, error: error instanceof Error ? error.message : 'worker failed' } satisfies Reply); }
  finally { fileOps.renameSync = originalRename; }
 });
 process.send!({ ready: true } satisfies Reply);
} else {
 class Worker {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #next = 0;
  constructor(root: string) {
   this.child = fork(import.meta.filename, [], { execArgv: [], env: { ...process.env, QQBOT_PHOTO_CONCURRENCY_CHILD: '1', QQBOT_PHOTO_CONCURRENCY_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
   this.child.stdout?.resume(); this.child.stderr?.resume();
   let start!: () => void; let failed!: (error: Error) => void;
   this.ready = new Promise((resolve, reject) => { start = resolve; failed = reject; });
   this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
   const hard = setTimeout(() => this.child.kill('SIGKILL'), CHILD_LIMIT_MS);
   this.child.on('message', (message: Reply) => {
    if (message.ready) { start(); return; }
    const waiting = message.id === undefined ? undefined : this.#pending.get(message.id);
    if (!waiting) return;
    this.#pending.delete(message.id!); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.value);
   });
   const abort = () => {
    clearTimeout(hard); failed(new Error('synthetic worker exited before ready'));
    for (const waiter of this.#pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('synthetic worker exited')); }
    this.#pending.clear();
   };
   this.child.once('error', abort); this.child.once('exit', abort);
  }
  request(command: Omit<Command, 'id'>): Promise<unknown> {
   const id = ++this.#next;
   return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.#pending.delete(id); this.child.kill('SIGKILL'); reject(new Error('synthetic command exceeded hard limit')); }, 8_000);
    this.#pending.set(id, { resolve, reject, timer });
    this.child.send({ ...command, id });
   });
  }
  async close() { if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL'); await this.exited; }
 }
 async function fixture(work: (f: { root: string; dir: string; file: (n: number) => string; worker: () => Promise<Worker> }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-process-')); const root = join(dir, 'shelf'); const workers: Worker[] = [];
  try {
   await work({ dir, root, file(n) { const path = join(dir, `${n}.jpg`); writeFileSync(path, `synthetic-photo-${n}`); return path; },
    async worker() { const worker = new Worker(root); workers.push(worker); await worker.ready; return worker; } });
  } finally { await Promise.all(workers.map(worker => worker.close())); rmSync(dir, { recursive: true, force: true }); }
 }
 async function checkpoint(path: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!existsSync(path)) { if (Date.now() > until) throw new Error('checkpoint never reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
 }

 test('两个独立进程并发添加保留全部条目，活Shelf立即看到外部添加', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const live = photoShelf({ dir: f.root, log: () => {}, now: clock });
   const [a, b] = await Promise.all([f.worker(), f.worker()]);
   const entries = await Promise.all([a.request({ op: 'add', source: f.file(1) }), b.request({ op: 'add', source: f.file(2) })]);
   assert.equal(new Set(entries.map(entry => (entry as { id: string }).id)).size, 2);
   assert.equal(live.list().length, 2); assert.equal(live.status().count, 2); assert.equal(live.has('cat'), true);
   for (const entry of entries as { id: string }[]) assert.ok(live.resolve(`<photo:${entry.id}>`));
   assert.ok(live.prompt('cat'));
   assert.equal(photoShelf({ dir: f.root, log: () => {} }).list().length, 2);
  });
 });

 test('两个独立进程并发used不丢增量，活Shelf可见计数且不需要重启', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const live = photoShelf({ dir: f.root, log: () => {}, now: clock }); const entry = live.add(f.file(1), 'cat', '合成照片');
   const [a, b] = await Promise.all([f.worker(), f.worker()]);
   await Promise.all([a.request({ op: 'used', photo: entry.id, times: 12 }), b.request({ op: 'used', photo: entry.id, times: 12 })]);
   assert.equal(live.list()[0]!.used, 24); assert.equal(photoShelf({ dir: f.root, log: () => {} }).list()[0]!.used, 24);
  });
 });

 test('外部remove和另一进程add同时提交不复活旧照片，活Shelf撤下发送资格', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const live = photoShelf({ dir: f.root, log: () => {}, now: clock }); const entry = live.add(f.file(1), 'cat', '合成照片');
   const [a, b] = await Promise.all([f.worker(), f.worker()]);
   await Promise.all([a.request({ op: 'remove', photo: entry.id }), b.request({ op: 'add', source: f.file(2) })]);
   assert.equal(live.list().length, 1); assert.notEqual(live.list()[0]!.id, entry.id);
   assert.equal(live.resolve(`<photo:${entry.id}>`), undefined); assert.equal(live.clean(`<photo:${entry.id}>`), '');
  });
 });

 for (const phase of ['before', 'after']) test(`写JSON的${phase}边界强杀持有者，重启按JSON事实恢复且无永久锁`, { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const initial = photoShelf({ dir: f.root, log: () => {}, now: clock }); initial.add(f.file(1), 'cat', '旧合成照片');
   const before = readFileSync(join(f.root, 'index.json'), 'utf8'); const child = await f.worker(); const point = join(f.dir, 'checkpoint');
   const pending = child.request({ op: 'add', source: f.file(2), phase, checkpoint: point }).catch(() => undefined);
   await checkpoint(point); await child.close(); await pending;
   if (phase === 'before') assert.equal(readFileSync(join(f.root, 'index.json'), 'utf8'), before);
   const recovered = photoShelf({ dir: f.root, log: () => {}, now: clock });
   assert.equal(recovered.list().length, phase === 'before' ? 1 : 2);
   recovered.add(f.file(3), 'cat', '恢复后照片');
   assert.equal(photoShelf({ dir: f.root, log: () => {} }).list().length, phase === 'before' ? 2 : 3);
  });
 });

 for (const phase of ['fail-before', 'fail-after']) test(`JSON发布${phase}报错后活Shelf及重启仍按磁盘事实，不覆盖或丢失原状态`, { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const live = photoShelf({ dir: f.root, log: () => {}, now: clock }); live.add(f.file(1), 'cat', '旧合成照片');
   const before = readFileSync(join(f.root, 'index.json'), 'utf8'); const child = await f.worker();
   if (phase === 'fail-before') await assert.rejects(child.request({ op: 'add', source: f.file(2), phase }));
   else await child.request({ op: 'add', source: f.file(2), phase });
   if (phase === 'fail-before') assert.equal(readFileSync(join(f.root, 'index.json'), 'utf8'), before);
   const expected = phase === 'fail-before' ? 1 : 2;
   assert.equal(live.list().length, expected); assert.equal(photoShelf({ dir: f.root, log: () => {} }).list().length, expected);
   await child.request({ op: 'add', source: f.file(3) });
   assert.equal(live.list().length, expected + 1);
  });
 });

 test('独立SQLite持锁时快速busy拒绝且不运行work，强杀持锁者后可恢复', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const shelf = photoShelf({ dir: f.root, log: () => {}, now: clock }); shelf.add(f.file(1), 'cat', '合成照片');
   const before = readFileSync(join(f.root, 'index.json'), 'utf8'); const child = await f.worker(); const point = join(f.dir, 'held');
   const pending = child.request({ op: 'hold', checkpoint: point }).catch(() => undefined); await checkpoint(point);
   let calls = 0; const began = performance.now();
   assert.throws(() => withPhotoIndexLock(f.root, () => { calls++; }), error => isBusy(error));
   assert.ok(performance.now() - began < 1_000, 'busy是短暂拒绝，不等待持锁者5秒退出');
   assert.equal(calls, 0); assert.equal(readFileSync(join(f.root, 'index.json'), 'utf8'), before);
   await child.close(); await pending;
   withPhotoIndexLock(f.root, () => { calls++; }); assert.equal(calls, 1);
   shelf.used(shelf.list()[0]!.id); assert.equal(shelf.list()[0]!.used, 1);
  });
 });

 test('used的JSON已发布后发生IO错误仍视为成功，不额外重放计数', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const live = photoShelf({ dir: f.root, log: () => {}, now: clock }); const entry = live.add(f.file(1), 'cat', '合成照片'); const child = await f.worker();
   await child.request({ op: 'used', photo: entry.id, phase: 'fail-after' });
   assert.equal(live.list()[0]!.used, 1);
   await child.request({ op: 'used', photo: entry.id });
   assert.equal(live.list()[0]!.used, 2); assert.equal(photoShelf({ dir: f.root, log: () => {} }).list()[0]!.used, 2);
  });
 });

 test('损坏协调库或协调路径IO失败不执行work、不覆盖JSON/坏库，也不退回无锁写', { timeout: 20_000 }, async () => {
  await fixture(async f => {
   const shelf = photoShelf({ dir: f.root, log: () => {}, now: clock }); const entry = shelf.add(f.file(1), 'cat', '合成照片');
   withPhotoIndexLock(f.root, () => {});
   const path = join(f.root, PHOTO_INDEX_LOCK_FILE); const original = readFileSync(path); const before = readFileSync(join(f.root, 'index.json'), 'utf8');
   const corrupt = 'PRIVATE_CORRUPT_COORDINATOR'; writeFileSync(path, corrupt); let calls = 0;
   assert.throws(() => withPhotoIndexLock(f.root, () => { calls++; }), error => error instanceof PhotoIndexLockError && !error.retryable && !error.message.includes(corrupt));
   assert.throws(() => shelf.used(entry.id)); assert.equal(calls, 0);
   assert.equal(readFileSync(path, 'utf8'), corrupt); assert.equal(readFileSync(join(f.root, 'index.json'), 'utf8'), before);
   rmSync(path); mkdirSync(path); writeFileSync(join(path, 'marker'), corrupt);
   assert.throws(() => withPhotoIndexLock(f.root, () => { calls++; }), error => error instanceof PhotoIndexLockError && !error.retryable);
   assert.throws(() => shelf.used(entry.id)); assert.equal(calls, 0);
   assert.equal(readFileSync(join(path, 'marker'), 'utf8'), corrupt); assert.equal(readFileSync(join(f.root, 'index.json'), 'utf8'), before);
   rmSync(path, { recursive: true }); writeFileSync(path, original); shelf.used(entry.id);
   assert.equal(shelf.list()[0]!.used, 1);
  });
 });
}
