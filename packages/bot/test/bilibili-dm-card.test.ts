import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseDmMessages } from '../src/bilibili/bilibili-account.ts';

describe('B 站私信读取（ADR 0168）', () => {
    test('私信：区分她/他、解析 JSON 正文、图片占位、按时间排序', () => {
        const messages = parseDmMessages({
            messages: [
                { msg_key: 2, sender_uid: 400000004, content: '{"content":"看了吗"}', timestamp: 1760000200 },
                { msg_key: 1, sender_uid: 3747573363903633, content: '{"content":"给你发个视频"}', timestamp: 1760000100 },
                { msg_key: 3, sender_uid: 400000004, content: '{"type":2}', timestamp: 1760000300 },
            ],
        }, 3747573363903633);
        assert.equal(messages.length, 3);
        assert.equal(messages[0]!.text, '给你发个视频');
        assert.equal(messages[0]!.fromMe, true);
        assert.equal(messages[1]!.fromMe, false);
        assert.equal(messages[2]!.text, '[图片]');
        assert.deepEqual(messages.map(message => message.at), [1760000100000, 1760000200000, 1760000300000]);
    });

    test('坏消息跳过；不是数组返回空', () => {
        assert.deepEqual(parseDmMessages({}, 1), []);
        assert.deepEqual(parseDmMessages({ messages: [null, { msg_key: '' }] }, 1), []);
    });
});
