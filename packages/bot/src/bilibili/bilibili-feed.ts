// B 站推荐流 + 「刷」的会话（ADR 0168 第 2 期，只读）：照 bili-cli 的 `feed recommend` 化用。
//   1) wbi 签名 → `x/web-interface/wbi/index/top/feed/rcmd` 拿一页推荐（账号级个性化，越刷越懂这个号）；
//   2) 一次会话刷 3–8 个：按口味决定「停」还是「划走」，停多久；同一批不重复；
//   3) 只记「看过什么」（标题/分区/时长/停留），不点赞、不评论、不关注。
// 失败（风控 / 签名变了 / 没登录态）返回 undefined，上层只记一行，不假装刷到了。

import type { BiliFetch } from './bilibili-view.ts';
import { fetchWbiKeys, mixinKey, signParams } from './bilibili-wbi.ts';
import { pick } from '../social/reply-timing.ts';

export interface FeedItem {
    bvid: string;
    cid?: number;
    title: string;
    owner: string;
    category: string;
    /** 秒 */
    duration: number;
    views: number;
    /** 推荐理由（B 站给的，可能是空） */
    reason?: string;
}

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
};

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const asRecord = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' ? value as Record<string, unknown> : undefined);

/** 她「会停下来」的分区（和刷视频发给他共用一张表，见 bilibili.ts 的 CATEGORY_OK 注释）；空分类也收 */
const WATCHABLE = /日常|搞笑|动物|喵星人|汪星人|美食|音乐|翻唱|演奏|影视|动漫|单机|手机游戏|网络游戏|科学|技术|运动|出行|摄影|数码|绘画|手工|穿搭|风光|旅游|生活|鬼畜/;
/** 不停的分区：新闻、社会、赛事、时政、金融 */
const AVOID = /新闻|资讯|社会|时政|军事|法律|赛事|电竞|股票|财经|汽车|房产/;
const BLOCKED_TITLE = /广告|商单|恰饭|抽奖|优惠|直播间|政治|战争|军事|事故|死亡|去世|车祸|血腥|恐怖|惊悚|疫情|股票|基金|彩票|赌|凶案|命案|悬案|杀(?:人|一个|死|害)|尸体|刑侦|受害者/;

/** 从 rcmd 的 data.item 里认一页推荐；认不出 bvid 的跳过 */
export function parseFeedItems(data: unknown): FeedItem[] {
    const root = asRecord(data);
    const list = Array.isArray(root?.item) ? root!.item : Array.isArray(root?.items) ? root!.items : [];
    const items: FeedItem[] = [];
    for (const entry of list) {
        const item = asRecord(entry);
        if (!item) continue;
        const bvid = str(item.bvid) || (str(item.goto) === 'av' ? str(item.id) : '');
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
        if (!str(item.title)) continue;
        items.push({
            bvid,
            ...(num(item.cid) ? { cid: num(item.cid) } : {}),
            title: str(item.title),
            owner: str(asRecord(item.owner)?.name),
            category: str(item.tname),
            duration: num(item.duration),
            views: num(asRecord(item.stat)?.view),
            ...(str(item.rcmd_reason) || str(asRecord(item.rcmd_reason)?.content) ? { reason: str(item.rcmd_reason) || str(asRecord(item.rcmd_reason)?.content) } : {}),
        });
        if (items.length >= 20) break;
    }
    return items;
}

/** 拿一页推荐。freshIdx 是「第几刷」，递增会让推荐更贴合；失败抛错，由调用方记一行 */
export async function fetchRecommend(doFetch: BiliFetch, options: { freshIdx?: number; count?: number } = {}): Promise<FeedItem[]> {
    const keys = await fetchWbiKeys(doFetch, HEADERS);
    const key = mixinKey(keys.imgKey, keys.subKey);
    const freshIdx = options.freshIdx ?? 1;
    const params = signParams({
        web_location: 1430654,
        y_num: options.count ?? 6,
        fresh_type: 4,
        feed_version: 'V8',
        fresh_idx: freshIdx,
        fresh_idx_1h: freshIdx,
        brush: freshIdx - 1,
        homepage_ver: 1,
        ps: options.count ?? 6,
        last_y_num: 5,
    }, key);
    const query = Object.entries(params).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&');
    const response = await doFetch(`https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${query}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`推荐接口 HTTP ${response.status}`);
    const json = JSON.parse(await response.text()) as { code?: number; message?: string; data?: unknown };
    if (json.code !== 0) throw new Error(`推荐接口 code ${String(json.code)}（${String(json.message ?? '')}）`);
    return parseFeedItems(json.data);
}

export interface StayVerdict { action: 'stay' | 'skip'; seconds: number; reason: string }

/**
 * 「停还是划走」：分区 / 标题黑名单直接划走；时长 <20 秒或 >30 分钟划走；其余的按日期哈希决定停多久（30 秒–3 分钟）。
 * 只看写法，不调模型；同样的视频同一天每次一样。
 */
export function stayVerdict(item: FeedItem, day: string): StayVerdict {
    if (BLOCKED_TITLE.test(`${item.title}`)) return { action: 'skip', seconds: 0, reason: '标题里有不要的词' };
    if (AVOID.test(item.category)) return { action: 'skip', seconds: 0, reason: `分区不看（${item.category}）` };
    if (item.category && !WATCHABLE.test(item.category)) return { action: 'skip', seconds: 0, reason: `分区不在口味里（${item.category}）` };
    if (item.duration < 20 || item.duration > 900) return { action: 'skip', seconds: 0, reason: '时长不合适' };
    const seconds = pick(`${day}:${item.bvid}`, 'feed-stay', [30, 180]);
    return { action: 'stay', seconds, reason: '对口' };
}

/** 这次刷几个：3–8 个，按日期哈希定；同一天每次一样 */
export function sessionSize(day: string): number {
    return pick(day, 'feed-size', [3, 8]);
}

export interface FeedSessionResult { visited: FeedItem[]; stayed: { item: FeedItem; seconds: number }[]; skipped: string[] }

/**
 * 一次会话：从候选里按顺序挑，最多 size 个；跳过看过的；每个按 stayVerdict 决定停多久。
 * 纯函数（不碰网络），方便测，也方便上层换成真会话。
 */
export function planSession(items: readonly FeedItem[], seen: readonly string[], day: string, size = sessionSize(day)): FeedSessionResult {
    const visited: FeedItem[] = [];
    const stayed: { item: FeedItem; seconds: number }[] = [];
    const skipped: string[] = [];
    for (const item of items) {
        if (visited.length >= size) break;
        if (seen.includes(item.bvid)) continue;
        visited.push(item);
        const verdict = stayVerdict(item, day);
        if (verdict.action === 'stay') stayed.push({ item, seconds: verdict.seconds });
        else skipped.push(item.bvid);
    }
    return { visited, stayed, skipped };
}
