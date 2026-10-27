// 看别人的 QQ 空间（ADR 0143）：NapCat 的 qzone 动作只覆盖「发说说」和（各版本不一的）自己的动态流，
// 别人的说说要自己走 Qzone 的网页接口——用她这个号自己的登录态（NapCat 的 get_cookies / get_csrf_token 能取到）。
//
// 这条路是「用她的身份看」，不是匿名：请求带的是她的 cookie 和 g_tk，Qzone 那边会记成她来过。
// 所以调用方要自己限流、只对名单里的人用，并且读到的正文不落日志（只记条数）。
//
// 接口（老版 emotion_cgi_msglist_v6）返回 JSONP，字段名和 NapCat 的 msgList 不一样（`msglist` / `content` / `created_time`），
// 这里统一转成 qzone-feed.ts 的 QzoneItem，后面的摘句、去重、进提示词都能复用。

import { normalizeQzoneFeed, type QzoneItem } from './qzone-feed.ts';

export interface QzoneSession {
    /** Qzone 用的 cookie 头（p_skey / skey / uin 等，只在这条请求里用） */
    cookie: string;
    /** g_tk：Qzone 网页接口要的 CSRF token，从 p_skey 算出来 */
    gtk: number;
    /** 她自己的 QQ 号（Qzone 接口里的 hostuin） */
    uin?: number;
}

/** 「k=v; k=v」字符串 → {name, value} 列表（NapCat get_cookies 的真实形状：cookies 是这样一整串） */
function parseCookieString(text: string): { name: string; value: string }[] {
    const pairs: { name: string; value: string }[] = [];
    for (const part of text.split(';')) {
        const at = part.indexOf('=');
        if (at > 0) pairs.push({ name: part.slice(0, at).trim(), value: part.slice(at + 1).trim() });
    }
    return pairs;
}

/** NapCat get_cookies 返回的 {cookies: 'k=v; k=v', bkn}（也认数组 {name, value, domain} 和裸字符串）→ cookie 头；拿不到 p_skey / skey 就当没有登录态 */
export function cookieHeader(raw: unknown): string | undefined {
    const inner = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { cookies?: unknown }).cookies : raw;
    const list = typeof inner === 'string' ? parseCookieString(inner) : (Array.isArray(inner) ? inner : []);
    const pairs = new Map<string, string>();
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const { name, value } = entry as { name?: unknown; value?: unknown };
        if (typeof name === 'string' && typeof value === 'string' && name) pairs.set(name, value);
    }
    if (!pairs.has('p_skey') && !pairs.has('skey')) return undefined;
    return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Qzone 的 g_tk：p_skey 上跑 djb2，取低 31 位。p_skey 没有就退回 skey（有些接口两样都收） */
export function gTk(pSkey: string): number {
    let hash = 5381;
    for (let i = 0; i < pSkey.length; i++) hash += (hash << 5) + pSkey.charCodeAt(i);
    return hash & 0x7fffffff;
}

export function sessionFromCookies(raw: unknown): QzoneSession | undefined {
    const cookie = cookieHeader(raw);
    if (!cookie) return undefined;
    const get = (name: string): string | undefined => cookie.split('; ').find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    const secret = get('p_skey') ?? get('skey') ?? '';
    if (!secret) return undefined;
    const uinText = get('uin') ?? '';
    const uin = Number(uinText.replace(/^o/, ''));
    return { cookie, gtk: gTk(secret), ...(Number.isSafeInteger(uin) && uin > 0 ? { uin } : {}) };
}

const HOST = 'https://user.qzone.qq.com';

/** 看某个人（hostUin）的空间说说列表。pos 从 0 开始，num 一次最多 20 左右（Qzone 自己的限制） */
export function userFeedUrl(input: { hostUin: number; gtk: number; pos?: number; num?: number }): string {
    const params = new URLSearchParams({
        uin: String(input.hostUin),
        ftype: '0',
        sort: '0',
        pos: String(input.pos ?? 0),
        num: String(input.num ?? 10),
        replynum: '0',
        g_tk: String(input.gtk),
        callback: '_preloadCallback',
        code_version: '1',
        format: 'jsonp',
        need_private_comment: '1',
    });
    return `${HOST}/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?${params.toString()}`;
}

/** 从 JSONP（`_preloadCallback({...})`）里抠出 JSON；不是 JSONP 就当纯 JSON 解析 */
export function jsonpBody(text: string): unknown {
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    const body = start >= 0 && end > start ? text.slice(start + 1, end) : text;
    try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

/** 把 Qzone 的返回转成统一的说说结构；失败（登录态过期、被风控、不是好友）返回 undefined */
export function parseUserFeed(data: unknown): QzoneItem[] | undefined {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as Record<string, unknown>;
    // Qzone 的错误是 {code: -3000, message: ...} 或 {message: '...'}；成功时 message 不是字符串或没有
    if (typeof record.code === 'number' && record.code !== 0) return undefined;
    const list = record.msglist ?? record.msgList ?? record.data;
    if (!Array.isArray(list)) return undefined;
    return normalizeQzoneFeed({
        msgList: list.map(item => {
            if (!item || typeof item !== 'object') return item;
            const entry = item as Record<string, unknown>;
            return {
                tid: entry.tid,
                content: entry.content,
                createTime: entry.created_time ?? entry.createTime,
                uin: entry.uin,
                nickname: entry.name,
                pic: entry.pic,
                likeCount: entry.likeNum ?? entry.like_count,
                commentCount: entry.cmntnum ?? entry.comment_count,
            };
        }),
    });
}

export interface UserFeedOptions {
    hostUin: number;
    session: QzoneSession;
    pos?: number;
    num?: number;
    /** 测试注入；线上用全局 fetch */
    fetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** 读一个人的空间说说。网络错误、登录态过期、被风控都返回 undefined（调用方只记一次） */
export async function readUserQzone(input: UserFeedOptions): Promise<QzoneItem[] | undefined> {
    const url = userFeedUrl({ hostUin: input.hostUin, gtk: input.session.gtk, ...(input.pos !== undefined ? { pos: input.pos } : {}), ...(input.num !== undefined ? { num: input.num } : {}) });
    const doFetch = input.fetch ?? ((target: string, init: { headers: Record<string, string> }) => fetch(target, init));
    try {
        const response = await doFetch(url, {
            headers: {
                cookie: input.session.cookie,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                referer: `https://user.qzone.qq.com/${input.hostUin}`,
            },
        });
        if (!response.ok) return undefined;
        const text = await response.text();
        return parseUserFeed(jsonpBody(text));
    } catch {
        return undefined;
    }
}
