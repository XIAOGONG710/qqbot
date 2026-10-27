// 刷陌生人（QQ 空间「空友爱看」那种推荐流），ADR 0144。
//
// 和 ADR 0143 的区别：143 读的是名单里的好友（确定能看谁），这里读的是平台推的陌生人——没有「谁的」这个概念，
// 所以策略也不一样：不记名字、不记 QQ 号、只在本地留正文样本（用来观察人平时怎么说话），不进日志。
//
// Qzone 的推荐流是网页端的接口，没有公开文档，而且换过几次。这里按候选地址逐个试，哪个能返回条目就用哪个；
// 全都不行就返回 undefined，上层记一行、不假装。每条候选都是「带她自己的 cookie + g_tk 的 GET」，
// 不带任何写操作，不点赞、不评论、不关注。

import type { QzoneSession } from './qzone-remote.ts';
import { jsonpBody } from './qzone-remote.ts';

export interface StrangerItem {
    /** 正文（压成一行，截到 160 字） */
    text: string;
    images: number;
    at?: number;
}

export interface StrangerFeed {
    /** 哪条候选接口读出来的（排障用，不进提示词） */
    action: string;
    items: StrangerItem[];
}

const MAX_TEXT = 160;

/** 候选接口：名字 + 组 URL。换过名字/参数的都列进来，探针会逐个试 */
export const STRANGER_FEED_ENDPOINTS: readonly { name: string; url: (session: QzoneSession) => string }[] = [
    {
        name: 'emotion_cgi_re_feeds',
        url: session => `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_re_feeds?uin=${session.uin ?? 0}&pos=0&num=8&g_tk=${session.gtk}&callback=_preloadCallback&format=jsonp`,
    },
    {
        name: 'qzone_recommend',
        url: session => `https://user.qzone.qq.com/proxy/domain/qzone.qq.com/cgi-bin/qzone_recommend?uin=${session.uin ?? 0}&num=8&g_tk=${session.gtk}&callback=_preloadCallback&format=jsonp`,
    },
    {
        name: 'feeds3_html_more',
        url: session => `https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?uin=${session.uin ?? 0}&scope=0&view=46&filter=all&flag=1&applist=all&refresh=0&aisort=1&pagenum=0&g_tk=${session.gtk}&callback=_preloadCallback&format=jsonp`,
    },
];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

/** 从任意 JSON 里找「像说说」的对象：有 content/summary/text，且不是评论 */
export function extractPosts(data: unknown, limit = 8): StrangerItem[] {
    const items: StrangerItem[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
        if (depth > 8 || items.length >= limit) return;
        if (Array.isArray(node)) { for (const entry of node) walk(entry, depth + 1); return; }
        const record = asRecord(node);
        if (!record) return;
        const text = [record.content, record.summary, record.text, record.title]
            .find(value => typeof value === 'string' && value.trim().length >= 4) as string | undefined;
        if (text && !('commentlist' in record && !('content' in record) && !('summary' in record))) {
            const flat = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            if (flat && !seen.has(flat)) {
                seen.add(flat);
                const time = Number(record.created_time ?? record.createTime ?? record.time ?? 0);
                items.push({
                    text: flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat,
                    images: Array.isArray(record.pic) ? record.pic.length : (Array.isArray(record.images) ? record.images.length : 0),
                    ...(Number.isFinite(time) && time > 0 ? { at: time < 1e12 ? time * 1000 : time } : {}),
                });
            }
        }
        for (const [key, value] of Object.entries(record)) {
            // 评论、回复、转发链里的正文不是「一条说说」，别把它们也收进来
            if (key === 'commentlist' || key === 'comments' || key === 'replyList' || key === 'rtlist') continue;
            walk(value, depth + 1);
        }
    };
    walk(data, 0);
    return items;
}

export interface StrangerFeedOptions {
    session: QzoneSession;
    endpoints?: typeof STRANGER_FEED_ENDPOINTS;
    limit?: number;
    fetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

const HEADERS = (session: QzoneSession): Record<string, string> => ({
    cookie: session.cookie,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    referer: 'https://user.qzone.qq.com/',
});

/** 逐个候选试，拿到第一份有条目的就停；全都不行返回 undefined */
export async function readStrangerFeed(options: StrangerFeedOptions): Promise<StrangerFeed | undefined> {
    const endpoints = options.endpoints ?? STRANGER_FEED_ENDPOINTS;
    const limit = options.limit ?? 8;
    const doFetch = options.fetch ?? ((url: string, init: { headers: Record<string, string> }) => fetch(url, init));
    for (const endpoint of endpoints) {
        try {
            const response = await doFetch(endpoint.url(options.session), { headers: HEADERS(options.session) });
            if (!response.ok) continue;
            const items = extractPosts(jsonpBody(await response.text()), limit);
            if (items.length) return { action: endpoint.name, items };
        } catch { /* 换下一个候选 */ }
    }
    return undefined;
}

const MAX_QUOTE = 40;

/** 给她看的一行：不带名字、不带号，只留「陌生人是这么说话的」那几句 */
export function strangerDigest(feed: StrangerFeed | undefined, limit = 3): string | undefined {
    if (!feed || !feed.items.length) return undefined;
    const quotes = feed.items.slice(0, limit).map(item => {
        const text = item.text.replace(/\s+/g, ' ').trim();
        return `「${text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text}」`;
    });
    return `你刚才刷了会儿空间，看到几条陌生人发的：${quotes.join('、')}（平时的人就是这么说话的）`;
}

/** 样本落盘用：只留正文和时间，不留名字和号 */
export function sampleLines(feed: StrangerFeed, at: number): string[] {
    return feed.items.map(item => JSON.stringify({ at, text: item.text, images: item.images }));
}
