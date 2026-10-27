import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { acquireLock, isProcessAlive } from '../src/platform/lock.ts';

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
        acquireLock(path, 111, () => false);
        assert.equal(readFileSync(path, 'utf8'), '111');

        writeFileSync(path, 'garbage');
        acquireLock(path, 333, () => true);
        assert.equal(readFileSync(path, 'utf8'), '333');
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
