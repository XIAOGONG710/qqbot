import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mixinKey, MIXIN_KEY_TABLE, signParams } from '../src/bilibili/bilibili-wbi.ts';
import { parseFeedItems, planSession, sessionSize, stayVerdict, type FeedItem } from '../src/bilibili/bilibili-feed.ts';
import { BILI_LIMITS, BiliLimiter, auditLine } from '../src/bilibili/bilibili-limit.ts';

const item = (patch: Partial<FeedItem> = {}): FeedItem => ({ bvid: 'BV1xx411c7mD', title: '楼下三花的一天', owner: '小雨', category: '喵星人', duration: 120, views: 100, ...patch });

describe('wbi 签名（ADR 0168 第 2 期）', () => {
    test('混音表 64 项、mixinKey 32 位、同输入同输出', () => {
        assert.equal(MIXIN_KEY_TABLE.length, 64);
        const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
        assert.equal(key.length, 32);
        assert.equal(key, mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'));
        assert.notEqual(key, mixinKey('00000000000000000000000000000000', '4932caff0ff746eab6f01bf08b70ac45'));
    });

    test('signParams：排序拼 query + 固定 wts，w_rid 是 32 位十六进制', () => {
        const signed = signParams({ b: 2, a: 'x y' }, 'KEY', 1700000000);
        assert.equal(signed.wts, 1700000000);
        assert.match(String(signed.w_rid), /^[0-9a-f]{32}$/);
        assert.equal(String(signed.w_rid), String(signParams({ a: 'x y', b: 2 }, 'KEY', 1700000000).w_rid));
        assert.notEqual(String(signed.w_rid), String(signParams({ a: 'x y', b: 2 }, 'OTHER', 1700000000).w_rid));
    });
});

describe('推荐流的一次「刷」', () => {
    test('认 item：只要 BV 号、标题；owner / 分区 / 时长 / 理由', () => {
        const items = parseFeedItems({ item: [
            { bvid: 'BV1aa411c7mD', title: '猫', owner: { name: '小雨' }, tname: '喵星人', duration: 60, stat: { view: 9 }, cid: 12, rcmd_reason: '因为你常看猫' },
            { bvid: 'bad', title: '坏的' },
            { id: 'BV1bb411c7mD', goto: 'av', title: '没有 bvid 字段' },
        ] });
        assert.equal(items.length, 2);
        assert.equal(items[0]!.owner, '小雨');
        assert.equal(items[0]!.cid, 12);
        assert.equal(items[0]!.reason, '因为你常看猫');
        assert.equal(items[1]!.title, '没有 bvid 字段');
    });

    test('停还是划走：分区 / 黑名单 / 时长；停的时长 30–180 秒', () => {
        assert.equal(stayVerdict(item(), 'd1').action, 'stay');
        assert.equal(stayVerdict(item({ category: '时事新闻' }), 'd1').action, 'skip');
        assert.equal(stayVerdict(item({ category: '汽车' }), 'd1').action, 'skip');
        assert.equal(stayVerdict(item({ title: '双十一优惠' }), 'd1').action, 'skip');
        assert.equal(stayVerdict(item({ duration: 5 }), 'd1').action, 'skip');
        const stay = stayVerdict(item(), 'd1');
        assert.ok(stay.seconds >= 30 && stay.seconds <= 180);
        assert.equal(stayVerdict(item(), 'd1').seconds, stay.seconds);
    });

    test('一次会话：3–8 个、跳过看过的；分两组计划', () => {
        const size = sessionSize('2026-10-26');
        assert.ok(size >= 3 && size <= 8);
        const items = [item({ bvid: 'BV1aa411c7mD' }), item({ bvid: 'BV1bb411c7mD', category: '新闻' }), item({ bvid: 'BV1cc411c7mD', category: '美食' })];
        const session = planSession(items, ['BV1aa411c7mD'], '2026-10-26', 2);
        assert.equal(session.visited.length, 2);
        assert.deepEqual(session.visited.map(entry => entry.bvid), ['BV1bb411c7mD', 'BV1cc411c7mD']);
        assert.deepEqual(session.skipped, ['BV1bb411c7mD']);
        assert.equal(session.stayed.length, 1);
    });
});

describe('写动作的节奏闸 + 审计', () => {
    test('评论：两次隔 10 秒；一小时 30 次；读动作不过这里', () => {
        const limiter = new BiliLimiter();
        let now = 1_000_000;
        assert.equal(limiter.take('comment', now).allowed, true);
        const second = limiter.take('comment', now + 1_000);
        assert.equal(second.allowed, false);
        assert.ok(!second.allowed && second.retryAfterMs > 0);
        now += BILI_LIMITS.comment.minGapMs;
        for (let i = 1; i < 30; i++) {
            assert.equal(limiter.take('comment', now).allowed, true);
            now += BILI_LIMITS.comment.minGapMs;
        }
        assert.equal(limiter.take('comment', now).allowed, false);
        now += 3_600_000;
        assert.equal(limiter.take('comment', now).allowed, true);
    });

    test('审计一行一条 JSON，只有动作 / 对象 / 结果', () => {
        const line = auditLine({ at: 1, action: 'comment', target: 'BV1xx411c7mD', ok: true });
        assert.deepEqual(JSON.parse(line), { at: 1, action: 'comment', target: 'BV1xx411c7mD', ok: true });
    });
});
