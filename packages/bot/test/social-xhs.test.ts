import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BreakerOpen, createBreaker } from '../src/platform-breaker.ts';
import { BudgetExhausted, createNavBudget, SocialReadError } from '../src/social.ts';
import { createXhsReader, normalizeXhsFeed, normalizeXhsNote, XHS_FEED_JS, xhsNoteJs, type RawXhsFeed } from '../src/social-xhs.ts';
import { fakePage, fastPacing } from './fake-page.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-xhs-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 夹具的键名和结构来自 2026-10-26 在这台虚拟机上不登录读到的真实页面状态（ADR 0166 的表）；内容是编的
const feedItem = (id: string, extra: Record<string, unknown> = {}) => ({ id, token: `tok-${id}`, model: 'note', type: 'normal', title: `标题${id}`, author: '作者甲', likes: '3611', ...extra });
const feedRaw = (...items: Array<Record<string, unknown>>): RawXhsFeed => ({ loggedIn: false, feeds: items as RawXhsFeed['feeds'] });

const noteRaw = (extra: Record<string, unknown> = {}) => ({
    id: 'n1', type: 'video', title: '咔嚓📸豹闪', desc: '和老朋友@某品牌 又见面啦😍\n#洗发水[话题]# 还是一如既往[笑哭R]的闪耀',
    author: '乙', tags: ['洗发水', '', '护发'], likes: '8万', commentCount: '4112', durationS: 286, time: 1786411386000,
    comments: [{ text: 'get同款', likes: '4' }, { text: '哈', likes: '99' }, { text: '这个真的好看，已经入了，等到货再来反馈一下使用感受', likes: '30' }, { text: '最前面的热评', likes: '500' }], ...extra,
});

describe('小红书：把读到的状态变成统一的形状', () => {
    test('列表：只要笔记、没标题的不要、同 id 去重；点赞数「8万」「3611」；视频 / 图文；链接带页面给的凭据', () => {
        const posts = normalizeXhsFeed(feedRaw(
            feedItem('a1'), feedItem('a2', { type: 'video', likes: '8万' }), feedItem('a1'),
            feedItem('ad', { model: 'ad' }), feedItem('empty', { title: '  ' }), { id: 42 }, feedItem('a3', { token: undefined, likes: undefined }),
        ));
        assert.deepEqual(posts.map(p => p.id), ['a1', 'a2', 'a3']);
        assert.deepEqual(posts.map(p => p.kind), ['image', 'video', 'image']);
        assert.deepEqual(posts.map(p => p.likes), [3611, 80000, undefined]);
        assert.equal(posts[0]!.url, 'https://www.xiaohongshu.com/explore/a1?xsec_token=tok-a1&xsec_source=pc_feed');
        assert.equal(posts[2]!.url, 'https://www.xiaohongshu.com/explore/a3');
        assert.equal(posts[2]!.xsec, undefined);
        assert.deepEqual(normalizeXhsFeed(null), []);
    });

    test('正文：去掉 [话题] 和表情代码、@ 留文字；标签去空；热评按点赞取前几条并截短；别人写的方括号不进来', () => {
        const base = normalizeXhsFeed(feedRaw(feedItem('n1', { type: 'video' })))[0]!;
        const post = normalizeXhsNote(noteRaw(), base);
        assert.equal(post.text, '和老朋友@某品牌 又见面啦😍 #洗发水 还是一如既往的闪耀');
        assert.deepEqual(post.tags, ['洗发水', '护发']);
        assert.equal(post.title, '咔嚓📸豹闪');
        // 点赞高的在前；只有一个字的「哈」不要
        assert.deepEqual(post.comments, ['最前面的热评', '这个真的好看，已经入了，等到货再来反馈一下使用感受', 'get同款']);
        const long = normalizeXhsNote(noteRaw({ comments: [{ text: '很长的评论'.repeat(20), likes: '1' }] }), base);
        assert.equal([...long.comments[0]!].length, 41, '每条热评最多 40 字（加一个省略号）');
        assert.equal(post.likes, 80000);
        assert.equal(post.commentCount, 4112);
        assert.equal(post.durationS, 286);
        assert.equal(post.postedAt, 1786411386000);
        assert.equal(post.platform, 'xhs');
        assert.equal(post.url, base.url);
        // 缺字段不崩，沿用列表里的
        const sparse = normalizeXhsNote({ id: 'n1' }, base);
        assert.equal(sparse.title, base.title);
        assert.deepEqual(sparse.comments, []);
    });
});

describe('小红书读者：开着的页面上读、滚、点开', () => {
    const setup = (state: { feed: RawXhsFeed; scrolled?: RawXhsFeed; note?: ReturnType<typeof noteRaw> | null; bodyText?: string; loggedIn?: boolean }, hook?: Parameters<typeof fakePage>[0]['onGoto']) => {
        const dataDir = tmp();
        const breaker = createBreaker({ dataDir, platform: 'xhs' });
        let wheeled = false;
        const page = fakePage({
            evaluate: expression => {
                if (expression === XHS_FEED_JS) return { ...(wheeled && state.scrolled ? state.scrolled : state.feed), loggedIn: state.loggedIn ?? false };
                if (expression === xhsNoteJs('n1')) return state.note ?? null;
                if (expression.includes('innerText')) return state.bodyText ?? '';
                return null;
            },
            onWheel: () => { wheeled = true; },
            ...(hook ? { onGoto: hook } : {}),
        });
        const budget = createNavBudget(12);
        const logs: string[] = [];
        const reader = createXhsReader({ page, breaker, pacing: fastPacing, budget, log: message => logs.push(message) });
        return { page, breaker, reader, budget, logs };
    };

    test('登录态读页面状态：访客 / 已登录', async () => {
        assert.deepEqual(await setup({ feed: feedRaw(feedItem('a')) }).reader.status(), { loggedIn: false, detail: '页面状态 loggedIn=false（访客）' });
        assert.equal((await setup({ feed: feedRaw(feedItem('a')), loggedIn: true }).reader.status()).loggedIn, true);
    });

    test('刷首页：每屏一次滚轮；滚出来的新内容并进去；去重', async () => {
        const { reader, page } = setup({ feed: feedRaw(feedItem('a'), feedItem('b')), scrolled: feedRaw(feedItem('a'), feedItem('b'), feedItem('c'), feedItem('c')) });
        const posts = await reader.feed(3);
        assert.deepEqual(posts.map(p => p.id), ['a', 'b', 'c']);
        assert.equal(page.wheels.length, 3);
        assert.ok(page.wheels.every(delta => delta >= 500 && delta <= 1000));
        assert.deepEqual(page.gotos, ['https://www.xiaohongshu.com/explore']);
    });

    test('点开视频笔记：读正文热评，按要求截帧；图文不截；截帧失败不影响正文', async () => {
        const video = setup({ feed: feedRaw(), note: noteRaw() });
        const base = normalizeXhsFeed(feedRaw(feedItem('n1', { type: 'video' })))[0]!;
        const opened = await video.reader.open(base, { watchMs: 9_000, frames: 2 });
        assert.equal(opened.frames.length, 2);
        assert.equal(opened.post.comments[0], '最前面的热评');
        assert.equal(video.page.gotos[0], base.url);
        const image = setup({ feed: feedRaw(), note: noteRaw({ type: 'normal' }) });
        const imageBase = normalizeXhsFeed(feedRaw(feedItem('n1')))[0]!;
        assert.equal((await image.reader.open(imageBase, { watchMs: 9_000, frames: 2 })).frames.length, 0);
        const failing = fakePage({ evaluate: expression => (expression === xhsNoteJs('n1') ? noteRaw() : null), screenshotFails: true });
        const logs: string[] = [];
        const reader = createXhsReader({ page: failing, breaker: createBreaker({ dataDir: tmp(), platform: 'xhs' }), pacing: fastPacing, budget: createNavBudget(), log: m => logs.push(m) });
        const result = await reader.open(base, { watchMs: 9_000, frames: 2 });
        assert.equal(result.frames.length, 0);
        assert.equal(result.post.title, '咔嚓📸豹闪');
        assert.match(logs[0]!, /截帧失败：截不了/);
    });

    test('读不到内容：页面上没有风控文字就是普通失败（不熔断）；有明确的风控文字就熔断', async () => {
        const base = normalizeXhsFeed(feedRaw(feedItem('n1')))[0]!;
        const plain = setup({ feed: feedRaw(), note: null, bodyText: '登录后推荐更懂你的笔记 手机号登录 输入验证码 获取验证码' });
        await assert.rejects(plain.reader.open(base, { watchMs: 0, frames: 0 }), (error: unknown) => error instanceof SocialReadError && error.kind === 'missing');
        assert.equal(plain.breaker.state(), undefined, '登录框里的「验证码」不算风控');
        const risky = setup({ feed: feedRaw(), note: null, bodyText: '请完成安全验证 拖动滑块' });
        await assert.rejects(risky.reader.open(base, { watchMs: 0, frames: 0 }), BreakerOpen);
        assert.equal(risky.breaker.state()?.reason, '页面出现「安全验证」');
    });

    test('读到了内容就不看页面文字：正文里写了「账号异常」的笔记不会让平台熔断', async () => {
        const base = normalizeXhsFeed(feedRaw(feedItem('n1')))[0]!;
        const { reader, breaker } = setup({ feed: feedRaw(), note: noteRaw({ desc: '我的账号异常了怎么办，访问频繁被限制' }), bodyText: '账号异常 访问频繁' });
        const opened = await reader.open(base, { watchMs: 0, frames: 0 });
        assert.match(opened.post.text, /账号异常/);
        assert.equal(breaker.state(), undefined);
    });

    test('平台自己的地址出 461：熔断，之后一次导航都不再发；别的域名的 429 不算', async () => {
        const base = normalizeXhsFeed(feedRaw(feedItem('n1')))[0]!;
        const other = setup({ feed: feedRaw(feedItem('a')) }, (_url, page) => { page.events.push({ url: 'https://cdn.example.com/x', status: 429 }); });
        await other.reader.feed(0);
        assert.equal(other.breaker.state(), undefined);
        const { reader, breaker, page } = setup({ feed: feedRaw(feedItem('a')), note: noteRaw() }, (_url, p) => { p.events.push({ url: 'https://edith.xiaohongshu.com/api/sns/web/v1/homefeed', status: 461 }); });
        await assert.rejects(reader.feed(1), BreakerOpen);
        assert.equal(breaker.state()?.code, 461);
        const before = page.gotos.length;
        await assert.rejects(reader.open(base, { watchMs: 0, frames: 0 }), BreakerOpen);
        assert.equal(page.gotos.length, before, '熔断之后不碰网络');
    });

    test('导航预算：用完就停（不是风控，不熔断）', async () => {
        const dataDir = tmp();
        const breaker = createBreaker({ dataDir, platform: 'xhs' });
        const page = fakePage({ evaluate: expression => (expression === XHS_FEED_JS ? feedRaw(feedItem('a')) : null) });
        const reader = createXhsReader({ page, breaker, pacing: fastPacing, budget: createNavBudget(2), log: () => undefined });
        await reader.feed(0);
        await reader.feed(0);
        await assert.rejects(reader.feed(0), BudgetExhausted);
        assert.equal(page.gotos.length, 2);
        assert.equal(breaker.state(), undefined);
    });
});
