// 抖音读者（ADR 0166）：首页的视频卡片读 DOM（div[data-aweme-id]，10-26 探针实测），点开之后读网页自己发出去的 detail / comment 响应。
// 抖音页面自己会不会发这些请求每次不一样（探针第 4 次就没发 detail），评论响应体还会被浏览器丢掉：读不到就降级，只用卡片上的标题、作者、时长。

import { clip, createRiskGuard, pause, parseCount, parseDuration, SCROLL_PX, SocialReadError, uniqueById, waitFor, type RiskGuard, type SocialPost, type SocialReader } from './social.ts';
import type { ReaderDeps } from './social-xhs.ts';

export const DOUYIN_HOME = 'https://www.douyin.com/';
export const DOUYIN_HOSTS = /^https:\/\/(?:www|www-hj)\.douyin\.com\//;
export const douyinUrl = (id: string) => `https://www.douyin.com/video/${id}`;

/** 登录了就会有的 cookie 名（匿名访问没有）；只看名字 */
export const DOUYIN_LOGIN_COOKIES = ['sessionid', 'sid_guard', 'sessionid_ss'];

export const DOUYIN_CARDS_JS = `(() => [...document.querySelectorAll('[data-aweme-id]')].slice(0, 120).map(e => {
  const t = e.querySelector('[data-feed-ad-click-refer="title"]'); const n = e.querySelector('[data-feed-ad-click-refer="name"]');
  return { id: e.getAttribute('data-aweme-id'), title: t ? t.textContent : '', author: n ? n.textContent : '', lines: (e.innerText || '').split('\\n').map(x => x.trim()).filter(Boolean).slice(0, 10) };
}))()`;

export const DOUYIN_VIDEO_READY_JS = `(() => { const v = document.querySelector('video'); return v ? { title: document.title, playing: !v.paused, t: v.currentTime, dur: v.duration } : null; })()`;

// ───────── 纯函数：把读到的东西变成统一的形状 ─────────

export interface RawCard { id?: unknown; title?: unknown; author?: unknown; lines?: unknown }

const COUNT_LINE = /^\d+(?:\.\d+)?[万亿]?$/;

export function normalizeDouyinCards(raw: RawCard[] | null | undefined): SocialPost[] {
    const posts: SocialPost[] = [];
    for (const card of raw ?? []) {
        if (typeof card?.id !== 'string' || !/^\d{6,}$/.test(card.id)) continue;
        const title = clip(card.title, 60);
        if (!title) continue;
        const lines = (Array.isArray(card.lines) ? card.lines : []).filter((line): line is string => typeof line === 'string');
        const durationS = lines.map(parseDuration).find(value => value !== undefined);
        const likes = lines.filter(line => COUNT_LINE.test(line)).map(parseCount).find(value => value !== undefined);
        posts.push({
            platform: 'douyin', id: card.id, url: douyinUrl(card.id), kind: 'video', title, text: '',
            author: clip(typeof card.author === 'string' ? card.author.replace(/^@/, '') : '', 20), tags: [], comments: [],
            ...(likes !== undefined ? { likes } : {}), ...(durationS !== undefined ? { durationS } : {}),
        });
    }
    return uniqueById(posts);
}

export interface DouyinDetail { desc?: string; author?: string; likes?: number; commentCount?: number; durationS?: number; postedAt?: number; tags: string[] }

/** aweme/detail 的响应：{ aweme_detail: { desc, author.nickname, statistics{digg_count,comment_count}, duration(毫秒), create_time(秒), text_extra[].hashtag_name } }；读不懂返回 undefined */
export function parseDouyinDetail(json: unknown): DouyinDetail | undefined {
    const detail = (json as { aweme_detail?: Record<string, any> } | null)?.aweme_detail;
    if (!detail || typeof detail !== 'object') return undefined;
    const tags = (Array.isArray(detail.text_extra) ? detail.text_extra : []).map((item: { hashtag_name?: unknown }) => (typeof item?.hashtag_name === 'string' ? clip(item.hashtag_name, 16) : '')).filter(Boolean).slice(0, 6);
    return {
        ...(typeof detail.desc === 'string' ? { desc: detail.desc } : {}),
        ...(typeof detail.author?.nickname === 'string' ? { author: detail.author.nickname } : {}),
        ...(typeof detail.statistics?.digg_count === 'number' ? { likes: detail.statistics.digg_count } : {}),
        ...(typeof detail.statistics?.comment_count === 'number' ? { commentCount: detail.statistics.comment_count } : {}),
        ...(typeof detail.duration === 'number' && detail.duration > 0 ? { durationS: Math.round(detail.duration / 1000) } : {}),
        ...(typeof detail.create_time === 'number' && detail.create_time > 0 ? { postedAt: detail.create_time * 1000 } : {}),
        tags,
    };
}

/** comment/list 的响应：{ comments: [{ text, digg_count }] }；按点赞取前几条，每条截短 */
export function parseDouyinComments(json: unknown): string[] {
    const list = (json as { comments?: unknown } | null)?.comments;
    if (!Array.isArray(list)) return [];
    return list
        .map((item: { text?: unknown; digg_count?: unknown }) => ({ text: clip(item?.text, 40), likes: typeof item?.digg_count === 'number' ? item.digg_count : 0 }))
        .filter(item => item.text.length >= 2)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5)
        .map(item => item.text);
}

/** 页面标题就是简介，后面可能跟站名 */
export const titleFromDocument = (title: unknown): string => clip(typeof title === 'string' ? title.replace(/\s*[-–—]\s*抖音\s*$/, '') : '', 60);

export function mergeDouyinDetail(base: SocialPost, detail: DouyinDetail | undefined, comments: string[], documentTitle: string): SocialPost {
    return {
        ...base,
        title: titleFromDocument(documentTitle) || base.title,
        text: clip(detail?.desc, 400) || base.text,
        author: clip(detail?.author, 20) || base.author,
        tags: detail?.tags.length ? detail.tags : base.tags,
        comments,
        ...(detail?.likes !== undefined ? { likes: detail.likes } : {}),
        ...(detail?.commentCount !== undefined ? { commentCount: detail.commentCount } : {}),
        ...(detail?.durationS !== undefined ? { durationS: detail.durationS } : {}),
        ...(detail?.postedAt !== undefined ? { postedAt: detail.postedAt } : {}),
    };
}

// ───────── 读者 ─────────

export function createDouyinReader(deps: ReaderDeps): SocialReader {
    const { page, pacing, budget, log } = deps;
    const guard: RiskGuard = deps.guard ?? createRiskGuard(page, deps.breaker, DOUYIN_HOSTS);

    async function visit(url: string): Promise<number> {
        budget.take();
        guard.before();
        const since = guard.mark();
        await page.goto(url, { timeoutMs: 30_000 });
        guard.afterStatuses(since);
        return since;
    }

    const readCards = () => page.evaluate<RawCard[] | null>(DOUYIN_CARDS_JS).catch(() => null);

    async function cardsAfterLoad(what: string): Promise<RawCard[]> {
        const first = await waitFor(pacing, async () => { const cards = await readCards(); return cards?.length ? cards : undefined; }, 12_000);
        if (!first) {
            await guard.afterMissing();
            throw new SocialReadError(`抖音${what}没读到视频卡片`, 'missing');
        }
        return first;
    }

    async function scrollCollect(screens: number, start: RawCard[]): Promise<SocialPost[]> {
        let latest = start;
        for (let i = 0; i < screens; i++) {
            guard.before();
            const since = guard.mark();
            await page.wheel(Math.round(SCROLL_PX * (0.8 + pacing.random() * 0.5)));
            await pause(pacing, 2_000, 5_000);
            guard.afterStatuses(since);
            const cards = await readCards();
            if (cards?.length) latest = cards;
        }
        return normalizeDouyinCards(latest);
    }

    /** 页面自己发出去的 JSON 响应：逐个试着读，读到第一个能解析的就用（有的响应体被浏览器丢了，有的是预检请求） */
    async function firstJson(match: RegExp, since: number): Promise<unknown> {
        for (const response of page.responses(match, since)) {
            if (response.status !== 200) continue;
            try { return JSON.parse(await response.body()); } catch { /* 这个读不了，试下一个 */ }
        }
        return undefined;
    }

    return {
        platform: 'douyin',
        async status() {
            await visit(DOUYIN_HOME);
            await waitFor(pacing, async () => (await readCards())?.length || undefined, 8_000);
            const names = await page.cookieNames(['https://www.douyin.com/']).catch(() => [] as string[]);
            const found = DOUYIN_LOGIN_COOKIES.filter(name => names.includes(name));
            return found.length ? { loggedIn: true, detail: `有登录 cookie（${found.join('、')}）` } : { loggedIn: false, detail: '没有登录 cookie（访客）' };
        },
        async feed(screens) {
            await visit(DOUYIN_HOME);
            const start = await cardsAfterLoad('首页');
            return scrollCollect(screens, start);
        },
        async search(keyword, screens) {
            await visit(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`);
            const start = await cardsAfterLoad(`搜「${keyword}」`);
            return scrollCollect(Math.min(screens, 2), start);
        },
        async open(post, { watchMs, frames }) {
            const since = await visit(post.url);
            const ready = await waitFor(pacing, async () => (await page.evaluate<{ title: string } | null>(DOUYIN_VIDEO_READY_JS).catch(() => null)) ?? undefined, 12_000);
            if (!ready) {
                await guard.afterMissing();
                throw new SocialReadError(`抖音这个视频没读到播放器（${post.id}）`, 'missing');
            }
            await pause(pacing, 2_500, 4_000);
            const detail = parseDouyinDetail(await firstJson(/\/aweme\/v1\/web\/aweme\/detail\//, since));
            const comments = parseDouyinComments(await firstJson(/\/web\/comment\/list\//, since));
            if (!detail) log('抖音：这次页面没发 detail 请求（或读不出来），只用卡片上的信息');
            const opened = mergeDouyinDetail(post, detail, comments, ready.title);
            const shots: Buffer[] = [];
            for (let i = 0; i < frames; i++) {
                await pause(pacing, watchMs / frames * 0.8, watchMs / frames * 1.2);
                try { shots.push(await page.screenshot({ jpegQuality: 60, clipTo: 'video' })); } catch (error) { log(`抖音截帧失败：${error instanceof Error ? error.message : String(error)}`); break; }
            }
            return { post: opened, frames: shots };
        },
    };
}
