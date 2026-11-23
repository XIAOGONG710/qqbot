import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { acquireLock, HEARTBEAT_STALE_MS, isProcessAlive } from '../src/platform/lock.ts';

describe('单实例锁', () => {
    let dir = '';
    let path = '';
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'qqbot-lock-'));
        path = join(dir, 'bot.lock');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('拿到锁时写入自己的 PID，释放后删掉', () => {
        const release = acquireLock(path, 111, () => false);
        assert.equal(readFileSync(path, 'utf8'), '111');
        release();
        assert.equal(existsSync(path), false);
    });

    test('另一个还活着的进程持有锁时拒绝启动', () => {
        writeFileSync(path, '222');
        assert.throws(() => acquireLock(path, 111, pid => pid === 222), /已有一个 bot 在运行（PID 222）/);
        assert.equal(readFileSync(path, 'utf8'), '222');
    });

    test('持有者已经不在了（被强杀留下的锁）或锁文件写坏了：接管', () => {
        writeFileSync(path, '222');
        const first = acquireLock(path, 111, () => false);
        assert.equal(readFileSync(path, 'utf8'), '111');
        first(); // Simulate the previous process exiting, including its OS lease.

        writeFileSync(path, 'garbage');
        const second = acquireLock(path, 333, () => true);
        assert.equal(readFileSync(path, 'utf8'), '333');
        second();
    });

    test('锁已经被别人接管时，释放不会删掉别人的锁', () => {
        const release = acquireLock(path, 111, () => false);
        writeFileSync(path, '222');
        release();
        assert.equal(readFileSync(path, 'utf8'), '222');
    });

    test('isProcessAlive：自己活着，不存在的 PID 不活', () => {
        assert.equal(isProcessAlive(process.pid), true);
        assert.equal(isProcessAlive(2 ** 30), false);
    });
});

describe('心跳：卡死/PID 复用的进程挡住启动时要能接管（2026-10-30）', () => {
    let dir = '';
    let path = '';
    let beat = '';
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'qqbot-lock-hb-'));
        path = join(dir, 'bot.lock');
        beat = join(dir, 'bot.lock.hb');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('PID 活着但心跳过期：接管', () => {
        writeFileSync(path, '222');
        writeFileSync(beat, String(Date.now() - HEARTBEAT_STALE_MS - 1000));
        const release = acquireLock(path, 111, () => true, { path: beat });
        assert.equal(readFileSync(path, 'utf8'), '111');
        release();
    });

    test('PID 活着、心跳还新：拒绝启动', () => {
        writeFileSync(path, '222');
        writeFileSync(beat, String(Date.now()));
        assert.throws(() => acquireLock(path, 111, () => true, { path: beat }), /已有一个 bot 在运行（PID 222）/);
    });

    test('还没写过心跳（刚启动的进程）：按活着处理，别抢', () => {
        writeFileSync(path, '222');
        assert.throws(() => acquireLock(path, 111, () => true, { path: beat }), /已有一个 bot 在运行/);
    });

});

// 2026-10-30 线上：锁文件被别的启动流程删掉、进程还在跑 → 下一次启动会起第二个实例。
// 当时靠心跳把锁文件补回来；11-05（54cbd680）起持锁的进程一直握着协调库的写事务，锁文件没了也起不了第二个——这里钉住这一点（心跳写者已删）
test('持锁时锁文件被删：第二个实例仍然拿不到（协调租约忙）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-lock-keep-'));
    const lockFile = join(dir, 'bot.lock');
    const release = acquireLock(lockFile);
    try {
        rmSync(lockFile);
        assert.throws(() => acquireLock(lockFile, 4242, () => true), /协调租约忙/);
    } finally {
        release();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 可能删不掉 */ }
    }
});
