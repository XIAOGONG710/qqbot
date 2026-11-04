import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { COMMAND_RECEIPT_TTL_MS, createCommandReceiptStore, MAX_COMMAND_RECEIPTS } from '../src/platform/command-receipts.ts';

const roots: string[] = [];
const originalRename = fileOps.renameSync;
afterEach(() => {
    fileOps.renameSync = originalRename;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('QQ 命令跨重启去重', () => {
    test('先原子落盘，重启后同一联系人和消息号不再领取', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-command-receipts-')); roots.push(root);
        const now = new Date('2026-11-04T00:00:00.000Z');
        assert.equal(createCommandReceiptStore({ dir: root }).claim(10001, 7, now), true);
        assert.equal(createCommandReceiptStore({ dir: root }).claim(10001, 7, now), false);
        assert.equal(createCommandReceiptStore({ dir: root }).claim(10002, 7, now), true);
        assert.doesNotMatch(readFileSync(join(root, 'commands.json'), 'utf8'), /\/dsh|配对|正文/);
    });

    test('写盘失败时不在内存里伪装已经领取', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-command-receipts-')); roots.push(root);
        const store = createCommandReceiptStore({ dir: root });
        fileOps.renameSync = (() => { throw new Error('disk full'); }) as typeof fileOps.renameSync;
        assert.throws(() => store.claim(10001, 8), /disk full/);
        fileOps.renameSync = originalRename;
        assert.equal(store.claim(10001, 8), true);
    });

    test('损坏文件让命令安全暂停，不会按空收据继续执行', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-command-receipts-')); roots.push(root);
        writeFileSync(join(root, 'commands.json'), '{bad json');
        const logs: string[] = [];
        const store = createCommandReceiptStore({ dir: root, log: line => logs.push(line) });
        assert.throws(() => store.claim(10001, 9), /拒绝启动|不可用/);
        assert.match(logs.join('\n'), /安全暂停/);
    });

    test('只保留最近七天且最多 4096 条', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-command-receipts-')); roots.push(root);
        const old = new Date('2026-10-01T00:00:00.000Z');
        const now = new Date(old.getTime() + COMMAND_RECEIPT_TTL_MS + 1);
        const receipts = Array.from({ length: MAX_COMMAND_RECEIPTS }, (_, index) => ({ userId: 10001, messageId: index, at: old.toISOString() }));
        writeFileSync(join(root, 'commands.json'), JSON.stringify({ version: 1, receipts }));
        const store = createCommandReceiptStore({ dir: root });
        assert.equal(store.claim(10001, 0, now), true, '过期消息号可以重新使用');
        const saved = JSON.parse(readFileSync(join(root, 'commands.json'), 'utf8')) as { receipts: unknown[] };
        assert.equal(saved.receipts.length, 1);
    });
});
