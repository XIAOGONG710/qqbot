import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchLikeFeed, fetchMentionFeed, inboxLine, mergeInbox, parseLikes, parseMentions } from '../src/bilibili/bilibili-inbox.ts';

describe('B 站收件箱（ADR 0168 第 3 期只读层）', () => {
    test('@我的：去 HTML、压空白、拼视频链接、秒转毫秒', () => {
        const entries = parseMentions({ items: [
            { id: 11, user: { mid: 9, nickname: '小雨' }, item: { type: 'reply', uri: 'BV1xx411c7mD', source_content: '<b>@她</b> 这个视频\n笑死' }, at_time: 1760000000 },
            { id: 12, item: { source_content: '没有人的' } },
            { id: 13, user: { mid: 9 }, item: { source_content: '' } },
        ] });
        assert.equal(entries.length, 1);
        assert.deepEqual(entries[0], { kind: 'mention', id: '11', uid: 9, name: '小雨', text: '@她 这个视频 笑死', at: 1760000000000, link: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    });

    test('收到的赞：一个 id 聚合多个人，正文说清楚是评论还是视频', () => {
        const entries = parseLikes({ total: { items: [
            { id: 'l1', users: [{ mid: 9, nickname: 'a' }, { mid: 10, nickname: 'b' }], item: { type: 'reply', uri: 'BV1xx411c7mD' }, counts: 2, like_time: 1760000100 },
            { id: 'l2', users: [{ mid: 11, nickname: 'c' }], item: { type: 'video' }, like_time: 1760000200 },
        ] } });
        assert.equal(entries.length, 2);
        assert.equal(entries[0]!.text, '赞了你的评论（共 2 个赞）');
        assert.equal(entries[1]!.text, '赞了你的视频');
        assert.equal(entries[0]!.link, 'https://www.bilibili.com/video/BV1xx411c7mD');
    });

    test('合并：同 kind 同 id 去重留新的，按时间倒序；概览一句话', () => {
        const merged = mergeInbox([
            { kind: 'reply', id: '1', text: '旧', at: 1 },
            { kind: 'reply', id: '1', text: '新', at: 5 },
            { kind: 'mention', id: '2', text: '@', at: 4 },
            { kind: 'like', id: '3', text: '赞', at: 3 },
        ]);
        assert.deepEqual(merged.map(entry => entry.text), ['新', '@', '赞']);
        assert.equal(inboxLine(merged), '1 条回复、1 个 @、1 个赞');
        assert.equal(inboxLine([]), '没有新消息');
    });

    test('未登录：fetch 返回 undefined（不是「没有新消息」），调用方能记「要登录」', async () => {
        assert.equal(await fetchMentionFeed(async () => { throw new Error('B 站接口 code -101（账号未登录）'); }), undefined);
        assert.equal(await fetchLikeFeed(async () => { throw new Error('断网'); }), undefined);
        const ok = await fetchMentionFeed(async () => ({ items: [{ id: 1, user: { mid: 2 }, item: { source_content: '喂' } }] }));
        assert.equal(ok?.length, 1);
    });
});
