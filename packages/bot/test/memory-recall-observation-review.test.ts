import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import { fileOps } from '../src/memory/json-file.ts';

function fixture(work: (dir: string, history: ChatHistory) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-recall-observation-'));
    try { work(dir, new ChatHistory(dir)); }
    finally {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.ok(basename(dir).startsWith('qqbot-recall-observation-'));
        rmSync(dir, { recursive: true, force: true });
    }
}
const row = { role: 'user' as const, time: '2026-11-05T00:00:00Z', messageId: 1, content: 'SYNTHETIC_WITHDRAWN' };

test('撤回观察世代区分已接受但未持久的意图、重复和其他联系人的观察', () => fixture((_dir, history) => {
    history.append(1, row);
    assert.equal(history.recallRevision(1), 0);
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = () => { throw Object.assign(new Error('synthetic'), { code: 'EIO' }); };
        assert.throws(() => history.recall(1, 1));
        assert.equal(history.recallRevision(1), 1);
        assert.equal(history.recallRevision(2), 0);
        assert.throws(() => history.load(1), '调度信号不能绕过持久屏障');
        assert.throws(() => history.recall(1, 1));
        assert.equal(history.recallRevision(1), 1, '相同观察重试不冒认新的撤回');
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    history.flushIncoming(1);
    assert.equal(history.load(1)[0]!.content, RECALLED_TEXT);
    assert.equal(history.recall(1, 1), false);
    assert.equal(history.recallRevision(1), 1);
}));

test('首次状态读取失败及危机keep均不冒认接受了新的撤回', () => fixture((dir, history) => {
    writeFileSync(join(dir, 'chats', '1.recalled.json'), 'SYNTHETIC_BAD_STATE');
    assert.throws(() => history.recall(1, 1));
    assert.equal(history.recallRevision(1), 0);
    history.append(2, row);
    assert.equal(history.recall(2, 1, () => true), false);
    assert.equal(history.recallRevision(2), 0);
    assert.equal(history.load(2)[0]!.content, row.content);
}));
