import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { BreakerOpen, createBreaker } from '../src/platform-breaker.ts';
import { createNavBudget, SocialReadError } from '../src/social.ts';
import { createDouyinReader, DOUYIN_CARDS_JS, DOUYIN_VIDEO_READY_JS, mergeDouyinDetail, normalizeDouyinCards, parseDouyinComments, parseDouyinDetail, titleFromDocument, type RawCard } from '../src/social-douyin.ts';
import { fakePage, fastPacing } from './fake-page.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-dy-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// 夹具：卡片的结构（data-aweme-id、title / name 属性、时长和播放数两行）和 detail 的字段名来自 2026-10-26 在这台虚拟机上不登录读到的真实页面；内容是编的
const card = (id: string, extra: Partial<RawCard> = {}): RawCard => ({ id, title: `视频${id}`, author: '@作者乙', lines: ['14:55', '8.8万', `视频${id}`, '@作者乙', '· 2天前'], ...extra });
const detailJson = { aweme_detail: { aweme_id: '7697621631518166282', desc: '第二十二集 被骗去 #原创动画 #AI漫剧', create_time: 1792242209, duration: 246156, author: { nickname: '动动漫剧' }, statistics: { digg_count: 30000, comment_count: 812 }, text_extra: [{ hashtag_name: '原创动画' }, { hashtag_name: 'AI漫剧' }, { type: 1 }] } };
const commentsJson = { comments: [{ text: '哈哈哈', digg_count: 3 }, { text: '这集的反转我没想到', digg_count: 900 }, { text: '1', digg_count: 5000 }, { text: '前排', digg_count: 20 }] };

describe('抖音：把读到的东西变成统一的形状', () => {
    test('卡片：时长和播放数各取各的；作者去掉 @；id 必须是长数字；没标题的、重复的不要', () => {
        const posts = normalizeDouyinCards([card('7699825880927022265'), card('7699825880927022265'), card('abc'), card('7699825880927022266', { title: '' }), card('7699825880927022267', { lines: ['第1集', '@甲'], author: '甲' }), { id: 5 } as RawCard]);
        assert.deepEqual(posts.map(p => p.id), ['7699825880927022265', '7699825880927022267']);
        assert.equal(posts[0]!.url, 'https://www.douyin.com/video/7699825880927022265');
        assert.equal(posts[0]!.durationS, 14 * 60 + 55);
        assert.equal(posts[0]!.likes, 88000);
        assert.equal(posts[0]!.author, '作者乙');
        assert.equal(posts[0]!.kind, 'video');
        assert.equal(posts[1]!.durationS, undefined);
        assert.equal(posts[1]!.likes, undefined);
        assert.deepEqual(normalizeDouyinCards(null), []);
    });

    test('detail：简介、作者、点赞评论数、时长（毫秒→秒）、发布时间（秒→毫秒）、话题；读不懂返回 undefined', () => {
        const detail = parseDouyinDetail(detailJson)!;
        assert.deepEqual(detail, { desc: '第二十二集 被骗去 #原创动画 #AI漫剧', author: '动动漫剧', likes: 30000, commentCount: 812, durationS: 246, postedAt: 1792242209000, tags: ['原创动画', 'AI漫剧'] });
        assert.equal(parseDouyinDetail({ status_code: 0 }), undefined);
        assert.equal(parseDouyinDetail(null), undefined);
        assert.deepEqual(parseDouyinDetail({ aweme_detail: {} }), { tags: [] });
    });

    test('评论：按点赞取前几条；一个字的不要；读不懂返回空', () => {
        assert.deepEqual(parseDouyinComments(commentsJson), ['这集的反转我没想到', '前排', '哈哈哈']);
        assert.deepEqual(parseDouyinComments({ comments: null }), []);
        assert.deepEqual(parseDouyinComments(undefined), []);
    });

    test('合并：标题用页面标题（去掉站名）；缺字段沿用卡片上的', () => {
        assert.equal(titleFromDocument('野兽先生活埋地下七天 - 抖音'), '野兽先生活埋地下七天');
        const base = normalizeDouyinCards([card('7699825880927022265')])[0]!;
        const full = mergeDouyinDetail(base, parseDouyinDetail(detailJson), ['好看'], '新标题 - 抖音');
        assert.equal(full.title, '新标题');
        assert.equal(full.text, '第二十二集 被骗去 #原创动画 #AI漫剧');
        assert.equal(full.durationS, 246);
        assert.deepEqual(full.comments, ['好看']);
        const bare = mergeDouyinDetail(base, undefined, [], '');
        assert.equal(bare.title, base.title);
        assert.equal(bare.durationS, base.durationS);
        assert.equal(bare.likes, base.likes);
    });
});

describe('抖音读者', () => {
    const ID = '7699825880927022265';
    const setup = (state: { cards?: RawCard[]; scrolled?: RawCard[]; ready?: { title: string } | null; bodyText?: string; cookies?: string[]; detail?: unknown; comments?: unknown; commentsFail?: boolean; }, onGoto?: Parameters<typeof fakePage>[0]['onGoto']) => {
        let wheeled = false;
        const page = fakePage({
            evaluate: expression => {
                if (expression === DOUYIN_CARDS_JS) return wheeled && state.scrolled ? state.scrolled : (state.cards ?? []);
                if (expression === DOUYIN_VIDEO_READY_JS) return state.ready === undefined ? { title: '标题 - 抖音' } : state.ready;
                if (expression.includes('innerText')) return state.bodyText ?? '';
                return null;
            },
            onWheel: () => { wheeled = true; },
            onGoto: (url, p) => {
                if (url.includes('/video/')) {
                    p.events.push({ url: 'https://www.douyin.com/aweme/v1/web/aweme/detail/?x=1', status: 200 });
                    p.events.push({ url: 'https://www-hj.douyin.com/aweme/v1/web/comment/list/?x=1', status: 200 });
                    p.events.push({ url: 'https://www-hj.douyin.com/aweme/v1/web/comment/list/?x=2', status: 200 });
                }
                onGoto?.(url, p);
            },
            cookies: state.cookies ?? [],
            bodies: [
                { match: /aweme\/detail/, body: JSON.stringify(state.detail ?? detailJson) },
                { match: /comment\/list\/\?x=1/, body: async () => { if (state.commentsFail) throw new Error('No resource with given identifier found'); return JSON.stringify(state.comments ?? commentsJson); } },
                { match: /comment\/list\/\?x=2/, body: JSON.stringify(state.comments ?? commentsJson) },
            ],
        });
        const breaker = createBreaker({ dataDir: tmp(), platform: 'douyin' });
        const logs: string[] = [];
        const reader = createDouyinReader({ page, breaker, pacing: fastPacing, budget: createNavBudget(12), log: m => logs.push(m) });
        return { page, breaker, reader, logs };
    };

    test('登录态看 cookie 名：没有 = 访客，有 sessionid = 已登录（只说名字）', async () => {
        assert.equal((await setup({ cards: [card(ID)] }).reader.status()).loggedIn, false);
        const logged = await setup({ cards: [card(ID)], cookies: ['ttwid', 'sessionid', 'odin_tt'] }).reader.status();
        assert.equal(logged.loggedIn, true);
        assert.equal(logged.detail, '有登录 cookie（sessionid）');
    });

    test('刷首页：滚轮一屏一次，新卡片并进来', async () => {
        const { reader, page } = setup({ cards: [card(ID)], scrolled: [card(ID), card('7699825880927022270')] });
        const posts = await reader.feed(2);
        assert.deepEqual(posts.map(p => p.id), [ID, '7699825880927022270']);
        assert.equal(page.wheels.length, 2);
    });

    test('点开：读 detail 和评论（评论响应体读不出来就试下一个）；截帧', async () => {
        const base = normalizeDouyinCards([card(ID)])[0]!;
        const { reader, page } = setup({ cards: [card(ID)], commentsFail: true });
        const opened = await reader.open(base, { watchMs: 8_000, frames: 2 });
        assert.equal(opened.post.text, '第二十二集 被骗去 #原创动画 #AI漫剧');
        assert.deepEqual(opened.post.comments, ['这集的反转我没想到', '前排', '哈哈哈']);
        assert.equal(opened.post.title, '标题');
        assert.equal(opened.frames.length, 2);
        assert.equal(page.gotos[0], `https://www.douyin.com/video/${ID}`);
    });

    test('页面没发 detail 请求：降级成只用卡片上的信息，记一行日志，不报错', async () => {
        const base = normalizeDouyinCards([card(ID)])[0]!;
        const dataDir = tmp();
        const page = fakePage({ evaluate: expression => (expression === DOUYIN_VIDEO_READY_JS ? { title: '页面标题 - 抖音' } : null) });
        const logs: string[] = [];
        const reader = createDouyinReader({ page, breaker: createBreaker({ dataDir, platform: 'douyin' }), pacing: fastPacing, budget: createNavBudget(), log: m => logs.push(m) });
        const opened = await reader.open(base, { watchMs: 0, frames: 0 });
        assert.equal(opened.post.title, '页面标题');
        assert.equal(opened.post.author, base.author);
        assert.deepEqual(opened.post.comments, []);
        assert.match(logs[0]!, /没发 detail 请求/);
    });

    test('读不到播放器：页面上有验证文字就熔断；没有就是普通失败', async () => {
        const base = normalizeDouyinCards([card(ID)])[0]!;
        const plain = setup({ ready: null, bodyText: '精选 推荐 关注' });
        await assert.rejects(plain.reader.open(base, { watchMs: 0, frames: 0 }), (e: unknown) => e instanceof SocialReadError && e.kind === 'missing');
        assert.equal(plain.breaker.state(), undefined);
        const risky = setup({ ready: null, bodyText: '请完成下列验证后继续：拖动滑块' });
        await assert.rejects(risky.reader.open(base, { watchMs: 0, frames: 0 }), BreakerOpen);
        assert.match(risky.breaker.state()!.reason, /页面出现「/);
    });

    test('抖音自己的地址出 429：熔断；首页读不到卡片也先看风控文字', async () => {
        const { reader, breaker } = setup({ cards: [card(ID)] }, (_url, p) => { p.events.push({ url: 'https://www.douyin.com/aweme/v1/web/tab/feed/', status: 429 }); });
        await assert.rejects(reader.feed(1), BreakerOpen);
        assert.equal(breaker.state()?.code, 429);
        const empty = setup({ cards: [], bodyText: '访问过于频繁，请稍后再试' });
        await assert.rejects(empty.reader.feed(1), BreakerOpen);
    });
});
