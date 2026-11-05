// 她自己在 B 站找表情包（ADR 0132，配置 biliStickers，默认关；要 stickers 和 bilibiliAccount 开着）。
// 用户 10-23：「表情包让她在 bilibili 自己找，不要用或者少用黄豆表情」。
// 原来她的图片表情来源是：他发来的、QQ 收藏里的、ChineseBQB 公开目录（43 张）。线上 10-22 到 10-23 的 91 次判定里 63 次“这轮不用”、28 次允许、3 次抽到、真发出去 1 次——
// 她用得极少，所以也没法顶替小黄脸。这里做两件事：
//   1. 来源换成 B 站（BQB 只在 B 站这路没东西时兜底）：
//      - 官方表情包：用她的号读 x/emote/user/panel/web，只取「热词系列」「tv_小电视」（图片、会随 B 站更新；不要「小黄脸」——用户不要；不要「颜文字」——是文字）；
//      - 评论区图片：热门视频热评里带图的（14% 的评论有图），按尺寸挑像表情包的（宽高 100–1000、比例 0.5–2、≤ 700 KB；大图多半是截图 / 宣传图）。
//      试过（真账号、24 个候选过她自己的收藏判断）：收了 21 个；但评论区图片里混进了真人的照片、视频截图、聊天界面截图，官方表情包全是干净的。
//   2. 评论区图片多一道筛（biliStickerScreen）：描述里是真人（男子 / 女子 / 真人照 / Coser……：路人的自拍和照片不收）、截图（界面 / 字幕 / 画面 / 海报 / 宣传）、广告引流的一律不收；
//      动漫、游戏、动物、卡通、文字梗照旧收（用户 10-12：「动漫 / 游戏 / 影视 IP 的表情包也行」）。官方表情包不用这道筛。
// 用的地方：stickers.ts 的 setTrend（运行时换掉公开目录的候选来源）、screen（收之前的筛）、stickerUncued（没有明确反应的允许轮次里也抽一抽，见 contact.ts）。

import type { BiliAccount, EmotePack } from '.././bilibili/bilibili-account.ts';
import type { JsonFetch } from './memes.ts';
import { unit } from './expression.ts';

/** 官方表情包里取哪几个：热词系列（会更新）、tv_小电视；不要小黄脸、颜文字 */
export const OFFICIAL_PACKS = /热词|tv_/;
/** 评论区图片：尺寸像表情包的 */
export const PIC_MAX_SIDE = 1000;
export const PIC_MIN_SIDE = 100;
export const PIC_MAX_KB = 700;
/** 每天给表情包收藏审看几个（B 站这路；原来公开目录是 3 个） */
export const BILI_STICKER_PER_DAY = 6;
/** 没有明确反应的、允许发表情的轮次里，抽到发一个的概率（原来没有这条路，她线上 437 轮里发了 1 个；真人约 9% 的轮次带表情包，调研 14.2） */
export const STICKER_UNCUED_CHANCE = 0.12;
const CACHE_MS = 60 * 60_000;

export interface PicturePost { img_src?: unknown; img_width?: unknown; img_height?: unknown; img_size?: unknown }

/** 一张评论区图片像不像表情包（只看尺寸）；是就返回地址 */
export function acceptCommentPicture(p: PicturePost): string | undefined {
    const url = typeof p.img_src === 'string' ? p.img_src : '';
    const w = Number(p.img_width);
    const h = Number(p.img_height);
    const kb = Number(p.img_size);
    if (!/^https?:\/\//.test(url) || !(w >= PIC_MIN_SIDE) || !(h >= PIC_MIN_SIDE) || w > PIC_MAX_SIDE || h > PIC_MAX_SIDE) return undefined;
    const aspect = w / h;
    // 大小是 0 / 没有 = 接口没给，不当成太大
    if (aspect < 0.5 || aspect > 2 || (Number.isFinite(kb) && kb > PIC_MAX_KB)) return undefined;
    return url;
}

/** 热评列表（reply/main 的 data）→ 里面像表情包的图片地址（含楼中楼预览） */
export function picturesOf(body: unknown): string[] {
    const replies = (body as { data?: { replies?: { content?: { pictures?: PicturePost[] }; replies?: { content?: { pictures?: PicturePost[] } }[] }[] } } | undefined)?.data?.replies;
    const out: string[] = [];
    for (const reply of Array.isArray(replies) ? replies : []) {
        for (const item of [reply, ...(Array.isArray(reply.replies) ? reply.replies : [])]) {
            for (const picture of Array.isArray(item.content?.pictures) ? item.content!.pictures! : []) {
                const url = acceptCommentPicture(picture);
                if (url) out.push(url);
            }
        }
    }
    return out;
}

/** 官方表情包：只留热词 / 小电视里的图片地址 */
export function officialStickers(packs: readonly EmotePack[]): string[] {
    return packs.filter(pack => OFFICIAL_PACKS.test(pack.text)).flatMap(pack => pack.urls);
}

export interface BiliStickerDeps {
    /** 她的 B 站号（按需打开；打不开返回 undefined） */
    account: () => Promise<BiliAccount | undefined>;
    fetch: JsonFetch;
    now: () => Date;
    log: (message: string) => void;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 一天里的轮换：同一天每次一样，换一天换一批（官方的几百个、评论区每小时都不一样） */
const rotate = <T>(list: readonly T[], seed: string): T[] => {
    if (!list.length) return [];
    const start = Math.floor(unit(seed) * list.length);
    return [...list.slice(start), ...list.slice(0, start)];
};

/**
 * B 站的表情包候选（给表情包收藏的 trendDiscover 用）：官方的和评论区的交替排，官方的按天轮换；读不到官方的就只有评论区的；
 * 都没有就用 fallback（原来的公开目录）。官方的缓存 12 小时、评论区的缓存 1 小时（收藏每小时才看一次，不用每次都去请求）
 */
export function biliStickerDiscover(deps: BiliStickerDeps, fallback?: (signal?: AbortSignal) => Promise<string[]>): (signal?: AbortSignal) => Promise<string[]> {
    let official: { at: number; urls: string[] } | undefined;
    let comments: { at: number; urls: string[] } | undefined;
    const read = async <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
        signal?.throwIfAborted();
        let abort: (() => void) | undefined;
        const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); }) : undefined;
        try {
            const pending = Promise.resolve().then(() => { signal?.throwIfAborted(); return work(); });
            const value = await (cancelled ? Promise.race([pending, cancelled]) : pending); signal?.throwIfAborted(); return value;
        } finally { if (abort) signal?.removeEventListener('abort', abort); }
    };
    const gap = (signal?: AbortSignal) => new Promise<void>((done, reject) => {
        signal?.throwIfAborted();
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done(); }, 400);
        signal?.addEventListener('abort', abort, { once: true });
    });
    const get = async (url: string, signal?: AbortSignal): Promise<unknown> => {
        const timeout = AbortSignal.timeout(15_000);
        const response = await read(signal, () => deps.fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
        if (!response.ok) throw new Error(`返回 ${response.status}`);
        return read(signal, () => response.json());
    };
    return async signal => {
        signal?.throwIfAborted();
        const now = deps.now().getTime();
        const day = `${deps.now().getFullYear()}-${deps.now().getMonth() + 1}-${deps.now().getDate()}`;
        signal?.throwIfAborted();
        try {
            const account = await read(signal, () => deps.account());
            if (account && (!official || now - official.at > 12 * CACHE_MS)) {
                const urls = account.emotePackages ? officialStickers(await read(signal, () => account.emotePackages!())) : [];
                signal?.throwIfAborted(); official = { at: now, urls };
            }
        } catch (error) { signal?.throwIfAborted(); deps.log(`B 站表情包：读官方表情包失败（${error instanceof Error ? error.message : String(error)}）`); }
        signal?.throwIfAborted();
        if (!comments || now - comments.at > CACHE_MS) {
            const urls: string[] = [];
            try {
                const popular = await get('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', signal) as { data?: { list?: { aid?: number }[] } };
                for (const video of (popular.data?.list ?? []).slice(0, 14)) {
                    if (!video.aid) continue;
                    signal?.throwIfAborted();
                    try { urls.push(...picturesOf(await get(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${video.aid}&mode=3&ps=20`, signal))); } catch { signal?.throwIfAborted(); /* 这个视频读不到就下一个 */ }
                    await gap(signal);
                }
            } catch (error) { signal?.throwIfAborted(); deps.log(`B 站表情包：读热门视频的评论区失败（${error instanceof Error ? error.message : String(error)}）`); }
            signal?.throwIfAborted();
            comments = { at: now, urls: [...new Set(urls)] };
        }
        const a = rotate(official?.urls ?? [], `${day} bili sticker official`);
        const b = rotate(comments.urls, `${day}${Math.floor(now / CACHE_MS)} bili sticker comment`);
        const merged: string[] = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) merged.push(a[i]!); if (b[i]) merged.push(b[i]!); }
        signal?.throwIfAborted();
        if (merged.length) return merged;
        return fallback ? read(signal, () => fallback(signal)) : [];
    };
}

/** 评论区图片收藏前的筛：描述里是真人、截图、广告引流的不收；返回原因，通过返回 undefined。官方表情包不用这道筛 */
const REAL_PERSON = /男子|女子|男生|女生|男士|女士|男人|女人|少年|少女(?!动漫)|真人|自拍|美女|帅哥|Coser|coser|cos |路人|情侣|婴儿|孩子/;
const SCREENSHOT = /界面|截图|字幕|游戏画面|直播|画面|海报|宣传|广告|引流|粉丝团|二维码|群号|公众号|订阅|关注|点赞|投币|弹幕|聊天记录|评论区|截屏|新闻|报道/;
export function biliStickerScreen(description: string, source: { kind: string; name?: string }): string | undefined {
    if (source.kind !== 'bili' || source.name !== 'comment') return undefined;
    if (REAL_PERSON.test(description)) return '真人的照片（路人的图不收）';
    if (SCREENSHOT.test(description)) return '截图 / 宣传 / 广告';
    return undefined;
}
