import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createLog, oneLine } from '../src/platform/log.ts';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

describe('日志一行一条（ADR 0070 第 15 项）', () => {
    test('外面来的字符串里的换行、回车、控制字符不能另起一行冒充系统日志', () => {
        assert.equal(oneLine('收到：你好\n[2026/10/13 18:00:00] 错误：假的'), '收到：你好 ⏎ [2026/10/13 18:00:00] 错误：假的');
        assert.equal(oneLine(`a\r\nb\rc${LINE_SEPARATOR}d`), 'a ⏎ b ⏎ c ⏎ d');
        assert.equal(oneLine(`x${NUL}y${ESC}z\ttab${DEL}`), 'xyz tab');
        assert.equal(oneLine('普通的一行：没有变化'), '普通的一行：没有变化');
    });

    test('写进文件的日志也是这样', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-log-'));
        const lines: string[] = [];
        createLog(dir, () => new Date(2026, 9, 13, 18, 0, 0), line => lines.push(line))('收到：第一行\n第二行 [伪造]');
        assert.equal(lines.length, 1);
        const file = readFileSync(join(dir, '2026-10-13.log'), 'utf8');
        assert.equal(file.trimEnd().split('\n').length, 1);
        assert.ok(file.includes('第一行 ⏎ 第二行'));
    });
});
