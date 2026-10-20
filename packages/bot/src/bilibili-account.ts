// B 站账号层（ADR 0089）：她有自己的 B 站号，用它搜视频、读字幕、在评论区 @ 他。
// 不登录读不到字幕（匿名取播放器信息返回 need_login_subtitle=true、字幕轨为 0，2026-10-20 实测），这是和 ADR 0084 第一层（匿名、公开榜）的区别。
// 这里只管和 B 站说话：所有请求经注入的 request 发出（测试注入假的），不碰聊天、不碰她的话。
// 参考：GitHub c1overzz/dsh-bili-scroll（MIT）的扫码登录、评论复核、字幕读取思路；接口细节来自它的实测记录。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BiliVideo } from './bilibili.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export interface BiliRequestInit {
    method?: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    /** 不跟随重定向（扫码轮询要读响应头里的 Set-Cookie） */
    noRedirect?: boolean;
}

export interface BiliResponse {
    ok: boolean;
    status: number;
    text(): Promise<string>;
    /** 响应头里的 Set-Cookie，一条一项（登录成功时凭证在这里） */
    setCookies?: readonly string[];
}

export type BiliRequest = (url: string, init: BiliRequestInit) => Promise<BiliResponse>;

/** 真的请求：全局 fetch，把 Set-Cookie 取出来 */
export const realRequest: BiliRequest = async (url, init) => {
    const response = await fetch(url, {
        ...(init.method ? { method: init.method } : {}),
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: init.signal,
        ...(init.noRedirect ? { redirect: 'manual' as const } : {}),
    });
    return { ok: response.ok || (init.noRedirect === true && response.status >= 300 && response.status < 400), status: response.status, text: () => response.text(), setCookies: response.headers.getSetCookie() };
};

/** B 站接口返回了错误码（code 不是 0）；风控是 -352 / -412 / -799，没登录是 -101，csrf 不对是 -111 */
export class BiliApiError extends Error {
    readonly code: number;
    constructor(message: string, code: number) {
        super(message);
        this.name = 'BiliApiError';
        this.code = code;
    }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE_HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
const TIMEOUT_MS = 10_000;

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const rec = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

// ───────── 凭证 ─────────

export interface BiliCredential {
    sessdata: string;
    biliJct: string;
    dedeUserId: string;
    buvid3: string;
    buvid4?: string;
    /** 登录接口给的刷新口令；现在还没用（Cookie 大约半年有效，过期重新扫码） */
    refreshToken?: string;
    savedAt: string;
}

const validCredential = (value: unknown): value is BiliCredential => {
    const c = rec(value);
    return typeof c.sessdata === 'string' && c.sessdata !== '' && typeof c.biliJct === 'string' && c.biliJct !== '' && typeof c.dedeUserId === 'string' && typeof c.buvid3 === 'string';
};

/** 凭证放数据目录下的 secrets/（runtime 已被 git 忽略；日志里从不写内容） */
export const credentialPath = (dataDir: string) => join(dataDir, 'secrets', 'bilibili.json');

export function loadCredential(path: string, log?: (message: string) => void): BiliCredential | undefined {
    const loaded = readJsonOr<BiliCredential | null>(path, null, log, { validate: (v): v is BiliCredential | null => v === null || validCredential(v), label: 'B 站账号凭证', invalid: 'throw' });
    return loaded ?? undefined;
}

export function saveCredential(path: string, credential: BiliCredential): void {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, credential);
}

/** 请求头里带的 Cookie；值保持 B 站给的样子（SESSDATA 里有 %2C 之类，不能再解码） */
export function cookieHeader(credential: BiliCredential): string {
    return [`SESSDATA=${credential.sessdata}`, `bili_jct=${credential.biliJct}`, `DedeUserID=${credential.dedeUserId}`, `buvid3=${credential.buvid3}`, ...(credential.buvid4 ? [`buvid4=${credential.buvid4}`] : [])].join('; ');
}

// ───────── 底层：GET / POST + 解 JSON ─────────

async function call(request: BiliRequest, url: string, init: Omit<BiliRequestInit, 'signal'>): Promise<{ data: unknown; setCookies: readonly string[] }> {
    const response = await request(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new BiliApiError(`B 站接口返回 ${response.status}`, response.status);
    const text = await response.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { throw new BiliApiError('B 站接口返回的不是 JSON', -999); }
    const code = typeof json.code === 'number' ? json.code : 0;
    if (code !== 0) throw new BiliApiError(`B 站接口 code ${code}（${str(json.message)}）`, code);
    return { data: json.data, setCookies: response.setCookies ?? [] };
}

// ───────── 扫码登录 ─────────

export interface QrStart { url: string; key: string }

/** 第一步：要一张登录二维码（链接 + 轮询用的 key，180 秒有效） */
export async function qrGenerate(request: BiliRequest): Promise<QrStart> {
    const { data } = await call(request, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header', { headers: { 'User-Agent': UA } });
    const d = rec(data);
    if (!str(d.url) || !str(d.qrcode_key)) throw new BiliApiError('生成二维码失败：返回里没有 url / qrcode_key', -999);
    return { url: str(d.url), key: str(d.qrcode_key) };
}

export type QrPoll =
    | { state: 'waiting' | 'scanned' | 'expired' }
    | { state: 'ok'; credential: BiliCredential }
    | { state: 'unknown'; code: number | undefined; message: string };

/** 从 Set-Cookie 里取出我们要的几个（名字区分大小写） */
export function pickCookies(setCookies: readonly string[]): Record<string, string> {
    const jar: Record<string, string> = {};
    for (const raw of setCookies) {
        const first = raw.split(';')[0] ?? '';
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4'].includes(name)) jar[name] = first.slice(eq + 1).trim();
    }
    return jar;
}

/** 访客 Cookie（buvid3 / buvid4）：浏览器打开 B 站首页时同样会取；不登录 */
export async function guestCookies(request: BiliRequest): Promise<{ buvid3: string; buvid4: string }> {
    const { data } = await call(request, 'https://api.bilibili.com/x/frontend/finger/spi', { headers: BASE_HEADERS });
    const d = rec(data);
    return { buvid3: str(d.b_3), buvid4: str(d.b_4) };
}

/**
 * 第二步：轮询一次。凭证在轮询响应的 Set-Cookie 头里（不在返回的 data.url 里——那是别的域的游戏票），
 * 所以这里不跟随重定向。code：86101 没扫 / 86090 扫了没确认 / 0 成功 / 86038 过期。
 */
export async function qrPoll(request: BiliRequest, key: string, now: () => number = Date.now): Promise<QrPoll> {
    const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`;
    const response = await request(url, { headers: { 'User-Agent': UA }, noRedirect: true, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await response.text()) as Record<string, unknown>; } catch { /* 轮询偶尔返回空体 */ }
    const data = rec(body.data);
    const code = typeof data.code === 'number' ? data.code : undefined;
    if (code === 86101) return { state: 'waiting' };
    if (code === 86090) return { state: 'scanned' };
    if (code === 86038) return { state: 'expired' };
    if (code !== 0) return { state: 'unknown', code, message: str(body.message) || str(data.message) };
    const jar = pickCookies(response.setCookies ?? []);
    if (!jar.SESSDATA || !jar.bili_jct || !jar.DedeUserID) {
        return { state: 'unknown', code, message: '登录成功了，但响应头里没有 SESSDATA / bili_jct / DedeUserID（B 站可能改了登录接口）' };
    }
    let buvid3 = jar.buvid3 ?? '';
    let buvid4 = jar.buvid4 ?? '';
    if (!buvid3) {
        try { ({ buvid3, buvid4 } = await guestCookies(request)); } catch { /* 拿不到就空着：只是个访客标识 */ }
    }
    return {
        state: 'ok',
        credential: {
            sessdata: jar.SESSDATA, biliJct: jar.bili_jct, dedeUserId: jar.DedeUserID, buvid3,
            ...(buvid4 ? { buvid4 } : {}),
            ...(str(data.refresh_token) ? { refreshToken: str(data.refresh_token) } : {}),
            savedAt: new Date(now()).toISOString(),
        },
    };
}

// ───────── WBI 签名（搜索、播放器信息现在要带） ─────────

const MIXIN_TABLE = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

export interface WbiKeys { imgKey: string; subKey: string }

/** 从 nav 返回里取两把钥匙：图片地址的文件名（不含扩展名） */
export function wbiKeysFrom(nav: unknown): WbiKeys | undefined {
    const wbi = rec(rec(nav).wbi_img);
    const name = (url: unknown) => str(url).split('/').pop()?.split('.')[0] ?? '';
    const imgKey = name(wbi.img_url);
    const subKey = name(wbi.sub_url);
    return imgKey && subKey ? { imgKey, subKey } : undefined;
}

export const wbiMixinKey = (keys: WbiKeys): string => {
    const original = keys.imgKey + keys.subKey;
    return MIXIN_TABLE.map(index => original[index] ?? '').join('').slice(0, 32);
};

/** 给一组参数签名，返回拼好的查询串（含 wts 和 w_rid）。值里的 !'()* 先去掉，和网页端一致 */
export function wbiSign(params: Record<string, string | number>, keys: WbiKeys, nowSeconds: number): string {
    const all: Record<string, string | number> = { ...params, wts: nowSeconds };
    const query = Object.keys(all).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${query}&w_rid=${createHash('md5').update(query + wbiMixinKey(keys)).digest('hex')}`;
}

// ───────── 字幕摘录 ─────────

/** 把字幕压成一小段给她看：去重复行、去网址和 @，太长就取开头、中间、结尾各一截（视频的大意不只在开头） */
export function subtitleExcerpt(lines: readonly string[], maxChars = 480): string {
    const clean: string[] = [];
    for (const raw of lines) {
        const line = raw.replace(/https?:\/\/\S+|www\.\S+|@\S+/g, '').replace(/\s+/g, ' ').trim();
        if (line && line !== clean.at(-1)) clean.push(line);
    }
    const whole = clean.join('，');
    if (whole.length <= maxChars) return whole;
    const part = Math.floor((maxChars - 6) / 3);
    const mid = Math.floor((whole.length - part) / 2);
    return `${whole.slice(0, part)} …… ${whole.slice(mid, mid + part)} …… ${whole.slice(whole.length - part)}`;
}

// ───────── 账号：搜、读字幕、评论、复核 ─────────

export type SearchOrder = 'totalrank' | 'click' | 'pubdate';

export type SubtitleResult =
    | { status: 'ok'; lan: string; lines: string[] }
    /** 视频没有字幕轨（纯音乐、无语音，或还没生成） */
    | { status: 'none' }
    /** 登录了还说要登录：Cookie 过期或被 B 站作废，要重新扫码 */
    | { status: 'needLogin' };

export interface BiliAccount {
    /** 账号昵称和 uid（日志里认得出是哪个号） */
    readonly name: string;
    readonly mid: number;
    search(keyword: string, order?: SearchOrder): Promise<BiliVideo[]>;
    subtitle(video: Pick<BiliVideo, 'bvid'> & { cid?: number }): Promise<SubtitleResult>;
    postComment(input: { aid: number; bvid: string; text: string; at?: { name: string; uid: number } }): Promise<{ rpid: string }>;
    /** 刚发的评论在公开的「最新」第一页里能不能找到（找不到不等于没发出去：可能在审核，也可能翻页看不到） */
    commentVisible(input: { aid: number; rpid: string }): Promise<boolean>;
    /**
     * 给一个人发私信（文字）。对方没关注她时 B 站限制很严（只能发一条，或直接被拒），所以用户要先关注她的号；
     * 过长（B 站实测约 500 字）会被拒，调用方自己控制长度
     */
    sendDm(input: { uid: number; text: string }): Promise<void>;
}

/** 私信一条最多这么多字（dsh-bili-scroll 实测 490 字发得出去、更长返回 21007）；留一点余地 */
export const DM_MAX_CHARS = 480;

const stripHtml = (text: string) => text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim();

/** 「3:45」「1:02:03」或秒数 → 秒 */
export function parseClock(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parts = str(value).split(':').map(Number);
    if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

/** nav 里的钥匙一天一换，这么久重取一次 */
const WBI_REFRESH_MS = 6 * 3_600_000;
const SUBTITLE_PREFERRED = /^(ai-)?zh/;

/**
 * 用凭证打开账号：先请求 nav 确认登录有效、拿到昵称和 WBI 钥匙；没登录（isLogin 为假）返回 undefined，调用方只写一行日志、不启用账号层。
 * 请求失败（风控、断网）会抛，调用方当作「这次起不来」。
 */
export async function openAccount(request: BiliRequest, credential: BiliCredential, options: { now?: () => number; log?: (message: string) => void } = {}): Promise<BiliAccount | undefined> {
    const now = options.now ?? Date.now;
    const headers = { ...BASE_HEADERS, Cookie: cookieHeader(credential) };
    let keys: WbiKeys | undefined;
    let keysAt = 0;
    const loadNav = async () => {
        const { data } = await call(request, 'https://api.bilibili.com/x/web-interface/nav', { headers });
        keys = wbiKeysFrom(data) ?? keys;
        keysAt = now();
        return rec(data);
    };
    const nav = await loadNav();
    if (nav.isLogin !== true) return undefined;
    const ensureKeys = async () => { if (!keys || now() - keysAt > WBI_REFRESH_MS) await loadNav(); return keys; };
    /** 带签名的 GET：拿不到钥匙就原样发（B 站有的接口还认） */
    const signedGet = async (base: string, params: Record<string, string | number>) => {
        const k = await ensureKeys();
        const query = k ? wbiSign(params, k, Math.floor(now() / 1000)) : Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
        return (await call(request, `${base}?${query}`, { headers })).data;
    };

    return {
        name: str(nav.uname),
        mid: num(nav.mid),

        async search(keyword, order = 'totalrank') {
            const data = rec(await signedGet('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword, order, page: 1, page_size: 20 }));
            const videos: BiliVideo[] = [];
            for (const raw of Array.isArray(data.result) ? data.result : []) {
                const item = rec(raw);
                const bvid = str(item.bvid);
                const title = stripHtml(str(item.title));
                if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !title) continue;
                videos.push({
                    bvid, aid: num(item.aid), title, desc: stripHtml(str(item.description)), owner: str(item.author), category: str(item.typename),
                    views: num(item.play), likes: num(item.like), duration: parseClock(item.duration), link: `https://www.bilibili.com/video/${bvid}`,
                });
            }
            return videos;
        },

        async subtitle(video) {
            let cid = video.cid ?? 0;
            if (!cid) {
                const view = rec((await call(request, `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(video.bvid)}`, { headers })).data);
                cid = num(view.cid);
                if (!cid) return { status: 'none' };
            }
            const player = rec(await signedGet('https://api.bilibili.com/x/player/wbi/v2', { bvid: video.bvid, cid }));
            const tracks = (Array.isArray(rec(player.subtitle).subtitles) ? rec(player.subtitle).subtitles as unknown[] : []).map(rec).filter(track => str(track.subtitle_url));
            if (!tracks.length) return player.need_login_subtitle === true ? { status: 'needLogin' } : { status: 'none' };
            const track = tracks.find(candidate => SUBTITLE_PREFERRED.test(str(candidate.lan))) ?? tracks[0]!;
            const url = str(track.subtitle_url).replace(/^\/\//, 'https://').replace(/^http:/, 'https:');
            const response = await request(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) throw new BiliApiError(`字幕文件返回 ${response.status}`, response.status);
            const body = rec(JSON.parse(await response.text()));
            const lines = (Array.isArray(body.body) ? body.body : []).map(item => str(rec(item).content)).filter(Boolean);
            return lines.length ? { status: 'ok', lan: str(track.lan), lines } : { status: 'none' };
        },

        async postComment({ aid, bvid, text, at }) {
            const form = new URLSearchParams({ type: '1', oid: String(aid), message: at ? `@${at.name} ${text}` : text, plat: '1', csrf: credential.biliJct });
            // 真的「提及」要把昵称对应的 uid 一起交上去；只写文字 @ 不会通知到人
            if (at) form.set('at_name_to_mid', JSON.stringify({ [at.name]: at.uid }));
            const { data } = await call(request, 'https://api.bilibili.com/x/v2/reply/add', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.bilibili.com', Referer: `https://www.bilibili.com/video/${bvid}` },
                body: form.toString(),
            });
            const d = rec(data);
            const rpid = str(d.rpid_str) || (num(d.rpid) ? String(num(d.rpid)) : '');
            if (!rpid) throw new BiliApiError('评论发出了，但返回里没有 rpid', -999);
            return { rpid };
        },

        async sendDm({ uid, text }) {
            if (text.length > DM_MAX_CHARS) throw new BiliApiError(`私信太长（${text.length} 字，上限 ${DM_MAX_CHARS}）`, 21007);
            const k = await ensureKeys();
            const seconds = Math.floor(now() / 1000);
            const form = new URLSearchParams({
                'msg[sender_uid]': String(num(nav.mid)), 'msg[receiver_id]': String(uid), 'msg[receiver_type]': '1', 'msg[msg_type]': '1', 'msg[msg_status]': '0',
                'msg[dev_id]': randomUUID().toUpperCase(), 'msg[timestamp]': String(seconds), 'msg[new_face_version]': '0', 'msg[content]': JSON.stringify({ content: text }),
                csrf_token: credential.biliJct, csrf: credential.biliJct,
            });
            // 这个接口近年也带 WBI 签名；拿不到钥匙就不签（签了多余的参数 B 站会忽略）
            const query = k ? wbiSign({ build: 0, mobi_app: 'web' }, k, seconds) : 'build=0&mobi_app=web';
            await call(request, `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${query}`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://message.bilibili.com', Referer: 'https://message.bilibili.com/' },
                body: form.toString(),
            });
        },

        async commentVisible({ aid, rpid }) {
            const { data } = await call(request, `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=0&ps=20`, { headers });
            const replies = Array.isArray(rec(data).replies) ? rec(data).replies as unknown[] : [];
            return replies.some(reply => (str(rec(reply).rpid_str) || String(num(rec(reply).rpid))) === rpid);
        },
    };
}
