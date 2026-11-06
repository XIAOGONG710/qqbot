import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { feedDigest, normalizeQzoneFeed, readQzoneFeed } from '../src/social/qzone-feed.ts';

describe('读 QQ 空间动态（ADR 0142）', () => {
    test('认得出常见的数据形状（msgList / list / 裸数组）', () => {
        const items = normalizeQzoneFeed({
            msgList: [
                { tid: 'a1', content: '楼下的猫又在门口蹲着', uin: 10001, nickname: '小雨', createTime: 1760000000, pic: ['1.jpg', '2.jpg'], likeCount: 3, commentCount: 1 },
                { tid: 'a2', content: '今天食堂的糖醋里脊居然不甜', createTime: '1760003600' },
                { tid: 'a3', content: '' },
            ],
        });
        assert.equal(items.length, 2);
        assert.deepEqual(items[0], {
            id: 'a1', uin: 10001, name: '小雨', text: '楼下的猫又在门口蹲着', images: 2, at: 1760000000000, likes: 3, comments: 1,
        });
        assert.equal(items[1]!.at, 1760003600000);
        assert.equal(normalizeQzoneFeed([{ id: 7, text: '一条' }]).length, 1);
        assert.equal(normalizeQzoneFeed(null).length, 0);
    });

    test('null、布尔值和数组不能经 Number 强转伪装成动态 id 或 QQ 号', () => {
        const items = normalizeQzoneFeed({ msgList: [
            { tid: null, content: '没有真实 id' },
            { tid: false, content: '布尔 id' },
            { tid: [], content: '数组 id' },
            { tid: '8', content: '合法数字字符串', uin: true, createTime: null },
        ] });
        assert.deepEqual(items, [{ id: '8', text: '合法数字字符串', images: 0 }]);
    });

    test('候选动作逐个试：第一个不存在就换下一个，并记住哪个能用', async () => {
        const tried: string[] = [];
        const feed = await readQzoneFeed(async action => {
            tried.push(action);
            if (action === 'get_qzone_msg_list') throw new Error('no such action');
            return { msgList: [{ tid: 'x', content: '海边的晚霞' }] };
        });
        assert.deepEqual(tried, ['get_qzone_msg_list', 'get_qzone_feeds']);
        assert.equal(feed?.action, 'get_qzone_feeds');
        assert.equal(feed?.items[0]?.text, '海边的晚霞');
    });

    test('全都调不通返回 undefined（上层记一行，不假装看到了）', async () => {
        const feed = await readQzoneFeed(async () => { throw new Error('no'); });
        assert.equal(feed, undefined);
    });

    test('摘成给她看的一行：只留文字，最长 40 字，去重', () => {
        const digest = feedDigest({
            action: 'get_qzone_msg_list',
            items: [
                { id: '1', text: '楼下的猫又在门口蹲着，估计比我上课还准时，蹲了一整个下午都不带动的', images: 0 },
                { id: '2', text: '楼下的猫又在门口蹲着，估计比我上课还准时，蹲了一整个下午都不带动的', images: 0 },
                { id: '3', text: '食堂的糖醋里脊\n居然不甜', images: 1 },
            ],
        });
        assert.match(digest ?? '', /^你刚才翻了会儿 QQ 空间，刷到：「楼下的猫/);
        assert.match(digest ?? '', /「食堂的糖醋里脊 居然不甜」/);
        assert.match(digest ?? '', /一共 3 条/);
        assert.equal((digest ?? '').includes('楼下的猫又在门口蹲着」，'), false);
        assert.equal(feedDigest({ action: 'x', items: [] }), undefined);
        assert.equal(feedDigest(undefined), undefined);
    });
});
