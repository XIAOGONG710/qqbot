import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { acquireLock, HEARTBEAT_STALE_MS, isProcessAlive, startHeartbeat } from '../src/platform/lock.ts';

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

    test('startHeartbeat 会写时间戳', () => {
        const stop = startHeartbeat(beat, 10_000);
        assert.ok(Number(readFileSync(beat, 'utf8')) > 0);
        stop();
    });
});

// 2026-10-30 线上：锁文件被别的启动流程删掉、进程还在跑 → 下一次启动会起第二个实例
test('心跳顺带把锁补回来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-lock-keep-'));
    const hb = join(dir, 'bot.lock.hb');
    const lockFile = join(dir, 'bot.lock');
    const stop = startHeartbeat(hb, 10_000, lockFile, 4242);
    assert.equal(readFileSync(lockFile, 'utf8'), '4242', '第一次心跳就把锁写上');
    rmSync(lockFile);
    stop();
    const stop2 = startHeartbeat(hb, 10_000, lockFile, 4242);
    assert.equal(readFileSync(lockFile, 'utf8'), '4242', '锁被删了，下一次心跳补回来');
    stop2();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 可能删不掉 */ }
});
