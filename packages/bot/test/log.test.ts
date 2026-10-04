import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createLog } from '../src/log.ts';

describe('日志文件', () => {
    let dir = '';
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qqbot-log-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test('打到终端，同时按本地日期追加到文件；跨过零点换一个文件', () => {
        let now = new Date(2026, 9, 4, 23, 59, 58);
        const printed: string[] = [];
        const log = createLog(join(dir, 'logs'), () => now, line => printed.push(line));
        log('第一行');
        log('第二行');
        now = new Date(2026, 9, 5, 0, 0, 1);
        log('第三行');

        assert.equal(printed.length, 3);
        assert.match(printed[0]!, /^\[2026\/10\/4 23:59:58\] 第一行$/);
        assert.equal(readFileSync(join(dir, 'logs', '2026-10-04.log'), 'utf8'), `${printed[0]}\n${printed[1]}\n`);
        assert.equal(readFileSync(join(dir, 'logs', '2026-10-05.log'), 'utf8'), `${printed[2]}\n`);
    });

    test('目录建不了时只打到终端，不抛错', () => {
        const blocker = join(dir, 'file');
        writeFileSync(blocker, '');
        const printed: string[] = [];
        const log = createLog(join(blocker, 'logs'), () => new Date(2026, 9, 4), line => printed.push(line));
        log('照常');
        assert.match(printed[0]!, /建不了，只打到终端/);
        assert.match(printed[1]!, /照常$/);
    });
});
