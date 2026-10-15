import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ChatHistory } from '../src/history.ts';

describe('聊天记录增量缓存与 schema', () => {
    test('append 同步更新缓存和 message-id 索引，外部改写后自动失效重读', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-history-'));
        try {
            const history = new ChatHistory(dir);
            history.append(1, { time: '2026-10-13T10:00:00.000Z', role: 'user', content: '一', messageId: 10 });
            assert.equal(history.hasMessage(1, 10), true);
            assert.equal(history.load(1).length, 1);
            appendFileSync(join(dir, 'chats', '1.jsonl'), JSON.stringify({ time: '2026-10-13T10:01:00.000Z', role: 'assistant', content: '二', messageId: 11 }) + '\n');
            assert.equal(history.load(1).length, 2, '文件被别的入口追加后，stat 变化使缓存失效');
            assert.equal(history.hasMessage(1, 11), true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('语法正确但字段错误的行不进入运行时，写入端也拒绝坏记录', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-history-schema-'));
        try {
            const logs: string[] = [];
            const path = join(dir, 'chats', '2.jsonl');
            const history = new ChatHistory(dir, message => logs.push(message));
            writeFileSync(path, [
                JSON.stringify({ time: '2026-10-13T10:00:00.000Z', role: 'user', content: '好', messageId: 1 }),
                JSON.stringify({ time: 'not-a-date', role: 'system', content: 7 }),
                '{broken',
            ].join('\n'));
            assert.deepEqual(history.load(2).map(message => message.content), ['好']);
            assert.match(logs[0]!, /忽略 2 行.*schema/);
            assert.throws(() => history.append(2, { time: 'bad', role: 'user', content: 'x' }), /schema/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
