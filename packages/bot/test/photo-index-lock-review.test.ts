import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, mock, test } from 'node:test';
import { PHOTO_INDEX_BUSY_MS, PHOTO_INDEX_LOCK_FILE, PhotoIndexLockError, withPhotoIndexLock } from '../src/vision/photo-index-lock.ts';

const directories: string[] = [];
const children = new Set<ChildProcess>();
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
    : new Promise<void>(resolve => child.once('exit', () => resolve()));
afterEach(async () => {
    const pending = [...children];
    for (const child of pending) child.kill('SIGKILL');
    await Promise.all(pending.map(exited));
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-lock-')); directories.push(dir);
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ count: 0, extension: 'keep' }));
    return dir;
}

function worker(dir: string, mode: 'increment' | 'hold' | 'publish'): ChildProcess {
    const path = join(dir, 'worker.mjs');
    writeFileSync(path, `
import { withPhotoIndexLock, PhotoIndexLockError } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/vision/photo-index-lock.ts')).href)};
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2], mode = process.argv[3];
const path = join(dir, 'index.json');
process.send({ ready: true });
await new Promise(resolve => process.once('message', resolve));
const deadline = Date.now() + 3000;
for (;;) {
 try {
  const count = withPhotoIndexLock(dir, () => {
   if (mode === 'hold') { process.send({ locked: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); return 0; }
   const next = JSON.parse(readFileSync(path, 'utf8')); next.count++;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
   const temp = path + '.tmp-' + process.pid;
   writeFileSync(temp, JSON.stringify(next)); renameSync(temp, path);
   if (mode === 'publish') { process.send({ published: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); }
   return next.count;
  });
  process.send({ count }); break;
 } catch (error) {
  if (error instanceof PhotoIndexLockError && error.retryable && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
  process.send({ failed: true, retryable: error.retryable }); break;
 }
}
process.disconnect();
`);
    const child = fork(path, [dir, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child); child.once('exit', () => children.delete(child)); return child;
}

async function message(child: ChildProcess): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('synthetic worker protocol timeout')); }, 5000);
        const received = (value: Record<string, unknown>) => { cleanup(); resolve(value); };
        const failed = () => { cleanup(); reject(new Error('synthetic worker exited before protocol reply')); };
        const cleanup = () => { clearTimeout(timer); child.removeListener('message', received); child.removeListener('exit', failed); };
        child.once('message', received); child.once('exit', failed);
    });
}

test('真实两进程锁内重读再加增量，两个更新和未知字段都保留', async () => {
    const dir = fixture(); const a = worker(dir, 'increment'), b = worker(dir, 'increment');
    await Promise.all([message(a), message(b)]);
    const results = [message(a), message(b)]; a.send('go'); b.send('go');
    const counts = (await Promise.all(results)).map(value => value.count).sort();
    await Promise.all([exited(a), exited(b)]);
    assert.deepEqual(counts, [1, 2]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')), { count: 2, extension: 'keep' });
});

test('真实争锁有界失败不调用work，繁忙分类安全；强杀持锁进程后可再次获取', async () => {
    const dir = fixture(); const child = worker(dir, 'hold'); await message(child);
    const locked = message(child); child.send('go'); assert.equal((await locked).locked, true);
    let called = false; const start = Date.now();
    assert.throws(() => withPhotoIndexLock(dir, () => { called = true; }), error => error instanceof PhotoIndexLockError && error.retryable);
    assert.equal(called, false); assert.ok(Date.now() - start < 1500); assert.equal(PHOTO_INDEX_BUSY_MS, 50);
    child.kill('SIGKILL'); await exited(child);
    assert.equal(withPhotoIndexLock(dir, () => 'recovered'), 'recovered');
});

test('JSON原子发布后进程被杀，SQLite释放不回滚JSON，下次从已发布事实继续', async () => {
    const dir = fixture(); const child = worker(dir, 'publish'); await message(child);
    const published = message(child); child.send('go'); assert.equal((await published).published, true);
    child.kill('SIGKILL'); await exited(child);
    const count = withPhotoIndexLock(dir, () => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).count);
    assert.equal(count, 1);
});

test('坏协调库和无法打开的库明确失败、无私密正文且原JSON与库保持', () => {
    for (const invalid of ['file', 'directory'] as const) {
        const dir = fixture(); const file = join(dir, PHOTO_INDEX_LOCK_FILE); const original = readFileSync(join(dir, 'index.json'), 'utf8');
        if (invalid === 'file') writeFileSync(file, 'PRIVATE_COORDINATOR_CONTENT'); else mkdirSync(file);
        let called = false;
        assert.throws(() => withPhotoIndexLock(dir, () => { called = true; }), error => error instanceof PhotoIndexLockError
            && !error.retryable && !error.message.includes('PRIVATE_COORDINATOR_CONTENT') && error.cause === undefined);
        assert.equal(called, false); assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), original);
        if (invalid === 'file') assert.equal(readFileSync(file, 'utf8'), 'PRIVATE_COORDINATOR_CONTENT');
        assert.deepEqual(readdirSync(dir).sort(), [PHOTO_INDEX_LOCK_FILE, 'index.json'].sort());
    }
});

test('旧协调库表中任意陈旧数据不参与所有权，JSON仍是事实源', () => {
    const dir = fixture(); const database = new DatabaseSync(join(dir, PHOTO_INDEX_LOCK_FILE));
    database.exec("CREATE TABLE old_owner(pid TEXT); INSERT INTO old_owner VALUES ('stale-owner')"); database.close();
    assert.equal(withPhotoIndexLock(dir, () => 'success'), 'success');
    const check = new DatabaseSync(join(dir, PHOTO_INDEX_LOCK_FILE));
    try { assert.equal(check.prepare('SELECT pid FROM old_owner').get()!.pid, 'stale-owner'); } finally { check.close(); }
});

test('work发布成功后rollback和close报错不改判失败，日志回调抛出也不覆盖结果', () => {
    const dir = fixture(); const originalExec = DatabaseSync.prototype.exec; const originalClose = DatabaseSync.prototype.close;
    let closed = 0; let logged = 0;
    const exec = mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
        if (sql === 'ROLLBACK') throw new Error('PRIVATE_RELEASE_ERROR'); return originalExec.call(this, sql);
    });
    const close = mock.method(DatabaseSync.prototype, 'close', function(this: DatabaseSync) { closed++; originalClose.call(this); throw new Error('PRIVATE_CLOSE_ERROR'); });
    try {
        assert.equal(withPhotoIndexLock(dir, () => { writeFileSync(join(dir, 'index.json'), '{"count":1}'); return 'applied'; }, () => { logged++; throw new Error('PRIVATE_LOG_ERROR'); }), 'applied');
        assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), '{"count":1}'); assert.equal(closed, 1); assert.equal(logged, 1);
    } finally { exec.mock.restore(); close.mock.restore(); }
    assert.equal(withPhotoIndexLock(dir, () => 'released'), 'released');
});

test('work失败保留原异常，即使释放失败；恢复后锁可以再次获取', () => {
    const dir = fixture(); const failure = new Error('synthetic callback failure'); const originalExec = DatabaseSync.prototype.exec;
    const exec = mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) { if (sql === 'ROLLBACK') throw new Error('synthetic cleanup failure'); return originalExec.call(this, sql); });
    try { assert.throws(() => withPhotoIndexLock(dir, () => { throw failure; }), error => error === failure); }
    finally { exec.mock.restore(); }
    assert.equal(withPhotoIndexLock(dir, () => 1), 1);
});

test('同步回调约束拒绝误传的Promise，释放连接且不泄漏未处理拒绝', () => {
    const dir = fixture();
    const asyncWork = (() => Promise.reject(new Error('synthetic async callback'))) as unknown as () => number;
    assert.throws(() => withPhotoIndexLock(dir, asyncWork), /只接受同步操作/);
    assert.equal(withPhotoIndexLock(dir, () => 'released'), 'released');
});

test('扩展SQLite错误码只按BUSY或LOCKED基础类别允许重试，IO与坏库不降级', () => {
    const dir = fixture(); const originalExec = DatabaseSync.prototype.exec;
    for (const [errcode, retryable] of [[5, true], [6, true], [5 | 0x100, true], [6 | 0x100, true], [10, false], [26, false]] as const) {
        let called = false;
        const exec = mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) {
            if (sql === 'BEGIN IMMEDIATE') throw Object.assign(new Error('PRIVATE_SQLITE_FAILURE'), { errcode });
            return originalExec.call(this, sql);
        });
        try {
            assert.throws(() => withPhotoIndexLock(dir, () => { called = true; }), error => error instanceof PhotoIndexLockError
                && error.retryable === retryable && !error.message.includes('PRIVATE_SQLITE_FAILURE'));
            assert.equal(called, false);
        } finally { exec.mock.restore(); }
    }
});

// Compile-time contract: accepted operations cannot intentionally return a Promise.
function synchronousCallbackTypeCheck(): void {
    // @ts-expect-error async callbacks are not safe inside a synchronous OS lock
    withPhotoIndexLock('unused-synthetic', async () => 1);
}
void synchronousCallbackTypeCheck;
