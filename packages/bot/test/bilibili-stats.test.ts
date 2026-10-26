import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseVideoStats, perHundred, statsLine } from '../src/bilibili-stats.ts';

describe('单稿公开数据（ADR 0168 第 3 期只读层）', () => {
    test('认两种形状：data.stat 和扁平 stat', () => {
        const flat = parseVideoStats({ view: 10000, like: 500, coin: 100, favorite: 200, reply: 30, danmaku: 40, share: 10 })!;
        assert.deepEqual(flat, { view: 10000, like: 500, coin: 100, favorite: 200, reply: 30, danmaku: 40, share: 10 });
        const nested = parseVideoStats({ stat: { view: 20000, like: 800, coin: 0, favorite: 0, reply: 0, danmaku: 0, share: 0 } })!;
        assert.equal(nested.view, 20000);
        assert.equal(nested.like, 800);
    });

    test('全 0 / 空对象当认不出，不返回假数据', () => {
        assert.equal(parseVideoStats({}), undefined);
        assert.equal(parseVideoStats({ view: 0, like: 0, coin: 0, favorite: 0 }), undefined);
        assert.equal(parseVideoStats(null), undefined);
    });

    test('每百播互动率：除零安全，保留一位小数', () => {
        const stats = { view: 10000, like: 420, coin: 110, favorite: 200, reply: 30, danmaku: 0, share: 0 };
        assert.deepEqual(perHundred(stats), { like: 4.2, coin: 1.1, favorite: 2, reply: 0.3 });
        assert.deepEqual(perHundred({ ...stats, view: 0 }), { like: 0, coin: 0, favorite: 0, reply: 0 });
    });

    test('摘要一行：万级换算 + 四个比率', () => {
        assert.equal(statsLine({ view: 123456, like: 5123, coin: 1200, favorite: 3400, reply: 300, danmaku: 0, share: 0 }), '播放 12.3 万、赞 5123、币 1200、藏 3400；每百播 赞 4.1 / 币 1 / 藏 2.8 / 评 0.2');
    });
});
