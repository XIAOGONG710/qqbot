import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ChatHistory, RECALLED_TEXT, type StoredMessage } from '../src/memory/history.ts';

function fixture(work: (dir: string, history: ChatHistory) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-recalled-view-'));
    try { work(dir, new ChatHistory(dir)); }
    finally { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-recalled-view-')); rmSync(dir, { recursive: true, force: true }); }
}
const row = (id: number, content = 'SYNTHETIC_BODY'): StoredMessage => ({ role: 'user', messageId: id, time: `2026-11-05T01:00:${String(id).padStart(2, '0')}Z`, content });

test('撤回来源标识由持久标记推导，重启仍可辨认且不向原始JSONL追加视图标识', () => fixture((dir, history) => {
    history.append(1, row(1)); history.append(1, row(2, RECALLED_TEXT));
    assert.equal(history.recall(1, 1), true);
    for (const view of [history.load(1), new ChatHistory(dir).load(1)]) {
        assert.equal(view[0]!.recalled, true); assert.equal(view[0]!.content, RECALLED_TEXT);
        assert.equal(view[1]!.recalled, undefined, '字面占位文本不能伪造已撤回来源');
    }
    const raw = readFileSync(join(dir, 'chats', '1.jsonl'), 'utf8');
    assert.match(raw, /SYNTHETIC_BODY/); assert.doesNotMatch(raw, /"recalled"/);
}));

test('原始同名字段不可信，危机keep不标为已遮盖，其他事实字段仍保留', () => fixture((dir, history) => {
    writeFileSync(join(dir, 'chats', '1.jsonl'), JSON.stringify({ ...row(1), recalled: true, sourceTime: 1793840401 }) + '\n');
    assert.equal(history.load(1)[0]!.recalled, undefined);
    assert.equal(history.load(1)[0]!.content, 'SYNTHETIC_BODY');
    assert.equal(history.load(1)[0]!.sourceTime, 1793840401);
    assert.equal(history.recall(1, 1, () => true), false);
    assert.equal(history.load(1)[0]!.recalled, undefined);
}));
