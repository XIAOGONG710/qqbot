import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractPosts, readStrangerFeed, sampleLines, strangerDigest } from '../src/social/qzone-strangers.ts';
import type { QzoneSession } from '../src/social/qzone-remote.ts';

const session: QzoneSession = { cookie: 'p_skey=abc; uin=o1', gtk: 42, uin: 1 };

describe('刷陌生人（ADR 0144）', () => {
    test('从任意 JSON 里认说说：去标签、压空白、截断、去重、跳过评论', () => {
        const items = extractPosts({
            data: {
                feeds: [
                    { content: '今天风好大<br/>吹得我头发都乱了', pic: ['a.jpg'] },
                    { content: '今天风好大<br/>吹得我头发都乱了' },
                    { commentlist: [{ content: '这是一条评论不是说说' }] },
                    { summary: '下雨了，不想出门', created_time: 1760000000 },
                ],
            },
        }, 8);
        assert.equal(items.length, 2);
        assert.equal(items[0]!.text, '今天风好大 吹得我头发都乱了');
        assert.equal(items[0]!.images, 1);
        assert.equal(items[1]!.at, 1760000000000);
    });

    test('候选逐个试：第一个 403 就换下一个，记住是哪个接口', async () => {
        const tried: string[] = [];
        const feed = await readStrangerFeed({
            session,
            endpoints: [
                { name: 'a', url: () => 'https://example.invalid/a' },
                { name: 'b', url: () => 'https://example.invalid/b' },
            ],
            fetch: async url => {
                const name = url.slice(url.lastIndexOf('/') + 1);
                tried.push(name);
                if (name === 'a') return { ok: false, status: 403, text: async () => '' };
                return { ok: true, status: 200, text: async () => '_preloadCallback({"feeds":[{"content":"海边的晚霞真好看"}]})' };
            },
        });
        assert.deepEqual(tried, ['a', 'b']);
        assert.equal(feed?.action, 'b');
        assert.equal(feed?.items[0]?.text, '海边的晚霞真好看');
    });

    test('全都不行 / 解析不出条目：返回 undefined', async () => {
        assert.equal(await readStrangerFeed({ session, fetch: async () => ({ ok: false, status: 500, text: async () => '' }) }), undefined);
        assert.equal(await readStrangerFeed({ session, fetch: async () => ({ ok: true, status: 200, text: async () => 'not json' }) }), undefined);
    });

    test('摘成一行：不带名字和号，最多 3 条、每条 40 字', () => {
        const digest = strangerDigest({
            action: 'a',
            items: [
                { text: '今天风好大吹得我头发都乱了，出门五分钟就后悔了，早知道就戴帽子了，真的真的，下次一定记得', images: 0 },
                { text: '食堂的糖醋里脊居然不甜', images: 1 },
            ],
        });
        assert.match(digest ?? '', /^你刚才刷了会儿空间，看到几条陌生人发的：/);
        assert.match(digest ?? '', /…」/);
        assert.equal((digest ?? '').includes('@'), false);
        assert.equal(strangerDigest(undefined), undefined);
    });

    test('样本只留正文、时间和图数，不留名字和号', () => {
        const lines = sampleLines({ action: 'a', items: [{ text: '下雨了', images: 0, at: 1 }] }, 99);
        assert.deepEqual(JSON.parse(lines[0]!), { at: 99, text: '下雨了', images: 0 });
    });
});
