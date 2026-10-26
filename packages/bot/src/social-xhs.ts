// 小红书读者（ADR 0166）：开着的浏览器页面里，读网页自己的状态 window.__INITIAL_STATE__（10-26 探针实测的结构，见 ADR 的表）。
// 不调带签名的接口：滚一滚，网页自己去取更多，我们再读它的状态。

import type { Page } from './browser-cdp.ts';
import { clip, createRiskGuard, pause, parseCount, SCROLL_PX, SocialReadError, uniqueById, waitFor, type NavBudget, type Pacing, type RiskGuard, type SocialPost, type SocialReader } from './social.ts';
import type { PlatformBreaker } from './platform-breaker.ts';

export const XHS_HOME = 'https://www.xiaohongshu.com/explore';
export const XHS_HOSTS = /^https:\/\/(?:www|edith|as)\.xiaohongshu\.com\//;

// ───────── 页面里跑的读取脚本（只读状态、不改页面） ─────────

/** Vue 的 ref 在状态里是 {_value}，先剥一层 */
const UNWRAP = `const u = v => (v && typeof v === 'object' && '_value' in v ? v._value : v);`;

export const XHS_FEED_JS = `(() => { ${UNWRAP}
  const s = window.__INITIAL_STATE__; if (!s) return null;
  const feeds = u(s.feed && s.feed.feeds) || [];
  const user = u(s.user) || {};
  return { loggedIn: u(user.loggedIn) === true, feeds: feeds.slice(0, 120).map(f => { const c = f.noteCard || {}; const a = c.user || {};
    return { id: f.id, token: f.xsecToken, model: f.modelType, type: c.type, title: c.displayTitle, author: a.nickname || a.nickName, likes: c.interactInfo && c.interactInfo.likedCount }; }) };
})()`;

export const XHS_SEARCH_JS = `(() => { ${UNWRAP}
  const s = window.__INITIAL_STATE__; if (!s || !s.search) return null;
  const feeds = u(s.search.feeds) || [];
  return { loggedIn: u((u(s.user) || {}).loggedIn) === true, feeds: feeds.slice(0, 120).map(f => { const c = f.noteCard || {}; const a = c.user || {};
    return { id: f.id, token: f.xsecToken, model: f.modelType, type: c.type, title: c.displayTitle, author: a.nickname || a.nickName, likes: c.interactInfo && c.interactInfo.likedCount }; }) };
})()`;

export const xhsNoteJs = (id: string) => `(() => { ${UNWRAP}
  const s = window.__INITIAL_STATE__; if (!s || !s.note) return null;
  const map = u(s.note.noteDetailMap) || {}; const d = map[${JSON.stringify(id)}]; if (!d || !d.note || !d.note.noteId) return null;
  const n = d.note; const list = u(d.comments && d.comments.list) || [];
  return { id: n.noteId, type: n.type, title: n.title, desc: n.desc, author: n.user && (n.user.nickname || n.user.nickName), tags: (n.tagList || []).map(t => t.name),
    likes: n.interactInfo && n.interactInfo.likedCount, commentCount: n.interactInfo && n.interactInfo.commentCount, durationS: n.video && n.video.capa && n.video.capa.duration, time: n.time,
    comments: list.slice(0, 10).map(c => ({ text: c.content, likes: c.likeCount })) };
})()`;

// ───────── 把读到的东西变成统一的形状（纯函数，测试用 10-26 探针的结构做夹具） ─────────

interface RawFeedItem { id?: unknown; token?: unknown; model?: unknown; type?: unknown; title?: unknown; author?: unknown; likes?: unknown }
export interface RawXhsFeed { loggedIn?: boolean; feeds?: RawFeedItem[] }

export const xhsUrl = (id: string, token?: string) => `https://www.xiaohongshu.com/explore/${id}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_feed` : ''}`;

export function normalizeXhsFeed(raw: RawXhsFeed | null | undefined): SocialPost[] {
    const posts: SocialPost[] = [];
    for (const item of raw?.feeds ?? []) {
        if (typeof item?.id !== 'string' || !item.id) continue;
        // 列表里还夹着广告位、话题卡等：只要笔记
        if (item.model !== undefined && item.model !== 'note') continue;
        const title = clip(item.title, 60);
        if (!title) continue;
        const token = typeof item.token === 'string' ? item.token : undefined;
        const likes = parseCount(item.likes);
        posts.push({
            platform: 'xhs', id: item.id, url: xhsUrl(item.id, token), kind: item.type === 'video' ? 'video' : 'image',
            title, text: '', author: clip(item.author, 20), tags: [], comments: [],
            ...(likes !== undefined ? { likes } : {}), ...(token ? { xsec: token } : {}),
        });
    }
    return uniqueById(posts);
}

interface RawNote { id?: unknown; type?: unknown; title?: unknown; desc?: unknown; author?: unknown; tags?: unknown; likes?: unknown; commentCount?: unknown; durationS?: unknown; time?: unknown; comments?: Array<{ text?: unknown; likes?: unknown }> }
export type RawXhsNote = RawNote;

/** 正文里的 [话题] 标记、@ 提及不要，留文字；热评取点赞最高的几条 */
export function normalizeXhsNote(raw: RawNote, base: SocialPost): SocialPost {
    // [话题] 是话题标记；[笑哭R] 这类是小红书自己的表情代码（clip 会去掉方括号，不先去掉就会漏出「笑哭R」）
    const text = clip(typeof raw.desc === 'string' ? raw.desc.replace(/\[话题\]#?/g, '').replace(/\[[^\]]{1,8}R\]/g, '') : '', 400);
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).filter((t): t is string => typeof t === 'string').map(t => clip(t, 16)).filter(Boolean).slice(0, 6);
    const comments = (raw.comments ?? [])
        .map(c => ({ text: clip(c.text, 40), likes: parseCount(c.likes) ?? 0 }))
        .filter(c => c.text.length >= 2)
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5)
        .map(c => c.text);
    const likes = parseCount(raw.likes);
    const commentCount = parseCount(raw.commentCount);
    const durationS = typeof raw.durationS === 'number' ? raw.durationS : undefined;
    const postedAt = typeof raw.time === 'number' && raw.time > 0 ? raw.time : undefined;
    return {
        ...base,
        kind: raw.type === 'video' ? 'video' : base.kind,
        title: clip(raw.title, 60) || base.title,
        text, tags, comments,
        author: clip(raw.author, 20) || base.author,
        ...(likes !== undefined ? { likes } : {}), ...(commentCount !== undefined ? { commentCount } : {}),
        ...(durationS !== undefined ? { durationS } : {}), ...(postedAt !== undefined ? { postedAt } : {}),
    };
}

// ───────── 读者 ─────────

export interface ReaderDeps {
    page: Page;
    breaker: PlatformBreaker;
    pacing: Pacing;
    budget: NavBudget;
    log: (message: string) => void;
    /** 测试注入；不给就按 breaker 和主机名建 */
    guard?: RiskGuard;
}

export function createXhsReader(deps: ReaderDeps): SocialReader {
    const { page, pacing, budget, log } = deps;
    const guard = deps.guard ?? createRiskGuard(page, deps.breaker, XHS_HOSTS);

    async function visit(url: string): Promise<void> {
        budget.take();
        guard.before();
        const since = guard.mark();
        await page.goto(url, { timeoutMs: 30_000 });
        guard.afterStatuses(since);
    }

    async function readList(js: string): Promise<RawXhsFeed | null> {
        return page.evaluate<RawXhsFeed | null>(js).catch(() => null);
    }

    /** 等页面状态里有列表（SSR 一般一开始就有） */
    async function listAfterLoad(js: string, what: string): Promise<RawXhsFeed> {
        const first = await waitFor(pacing, async () => { const raw = await readList(js); return raw?.feeds?.length ? raw : undefined; }, 12_000);
        if (!first) {
            await guard.afterMissing();
            throw new SocialReadError(`小红书${what}没读到列表`, 'missing');
        }
        return first;
    }

    async function scrollCollect(js: string, screens: number, start: RawXhsFeed): Promise<SocialPost[]> {
        let latest = start;
        for (let i = 0; i < screens; i++) {
            guard.before();
            const since = guard.mark();
            await page.wheel(Math.round(SCROLL_PX * (0.8 + pacing.random() * 0.5)));
            await pause(pacing, 2_000, 5_000);
            guard.afterStatuses(since);
            const raw = await readList(js);
            if (raw?.feeds?.length) latest = raw;
        }
        return normalizeXhsFeed(latest);
    }

    return {
        platform: 'xhs',
        async status() {
            await visit(XHS_HOME);
            const raw = await waitFor(pacing, async () => (await readList(XHS_FEED_JS)) ?? undefined, 10_000);
            if (!raw) { await guard.afterMissing(); return { loggedIn: false, detail: '首页没读到页面状态' }; }
            return { loggedIn: raw.loggedIn === true, detail: raw.loggedIn ? '页面状态 loggedIn=true' : '页面状态 loggedIn=false（访客）' };
        },
        async feed(screens) {
            await visit(XHS_HOME);
            const start = await listAfterLoad(XHS_FEED_JS, '首页');
            return scrollCollect(XHS_FEED_JS, screens, start);
        },
        async search(keyword, screens) {
            await visit(`https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`);
            const start = await listAfterLoad(XHS_SEARCH_JS, `搜「${keyword}」`);
            return scrollCollect(XHS_SEARCH_JS, Math.min(screens, 2), start);
        },
        async open(post, { watchMs, frames }) {
            await visit(post.url);
            const raw = await waitFor(pacing, async () => (await page.evaluate<RawNote | null>(xhsNoteJs(post.id)).catch(() => null)) ?? undefined, 12_000);
            if (!raw) {
                await guard.afterMissing();
                throw new SocialReadError(`小红书这条笔记没读到正文（${post.id}）`, 'missing');
            }
            const opened = normalizeXhsNote(raw, post);
            const shots: Buffer[] = [];
            if (opened.kind === 'video' && frames > 0) {
                // 视频自己在播（访客也自动播）：隔一会儿截一帧；截不到不影响读正文
                for (let i = 0; i < frames; i++) {
                    await pause(pacing, watchMs / frames * 0.8, watchMs / frames * 1.2);
                    try { shots.push(await page.screenshot({ jpegQuality: 60, clipTo: 'video' })); } catch (error) { log(`小红书截帧失败：${error instanceof Error ? error.message : String(error)}`); break; }
                }
            } else {
                await pause(pacing, 2_000, 5_000);
            }
            return { post: opened, frames: shots };
        },
    };
}
