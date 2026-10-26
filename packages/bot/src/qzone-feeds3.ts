// 好友动态流（QQ 空间 PC 端的 feeds3_html_more），ADR 0145。
//
// 这条流是「她自己的好友动态页」：好友发的说说、她自己发的说说、夹着的广告。10-25 在这台机器上实测它能读（HTTP 200、code 0），
// 但返回的不是 JSON，而是 JS 对象字面量（键名不带引号、单引号字符串、\x3C 之类的转义、数组末尾有 undefined），
// 所以 JSON.parse 不行；也不能 eval 一段来自网络的东西。这里写一个只认字面量的小解析器，认不出的地方直接抛，
// 调用方当「读不到」处理。
//
// 这条流本身只是「她刷自己的动态页」：不留访客记录，不点赞不评论。读到的正文只进提示词，不进日志。

import type { QzoneSession } from './qzone-remote.ts';

export interface FriendPost {
    /** 说说的 key（去重用） */
    id: string;
    /** 发的人（opuin） */
    uin: number;
    name?: string;
    text: string;
    images: number;
    /** 毫秒 */
    at?: number;
}

const MAX_DEPTH = 40;

/** 只认 JS 字面量（对象 / 数组 / 字符串 / 数字 / true false null undefined）的解析器；其它一律抛错 */
export function parseJsLiteral(source: string): unknown {
    let pos = 0;
    const fail = (message: string): never => { throw new Error(`${message}（位置 ${pos}）`); };
    const skip = (): void => { while (pos < source.length && /\s/.test(source[pos]!)) pos++; };

    function string(): string {
        const quote = source[pos++]!;
        let out = '';
        while (pos < source.length) {
            const ch = source[pos++]!;
            if (ch === quote) return out;
            if (ch !== '\\') { out += ch; continue; }
            const next = source[pos++];
            if (next === undefined) break;
            switch (next) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'v': out += '\v'; break;
                case '0': out += '\0'; break;
                case 'x': {
                    const hex = source.slice(pos, pos + 2);
                    if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('\\x 转义不对');
                    out += String.fromCharCode(parseInt(hex, 16)); pos += 2; break;
                }
                case 'u': {
                    const hex = source.slice(pos, pos + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 转义不对');
                    out += String.fromCharCode(parseInt(hex, 16)); pos += 4; break;
                }
                case '\n': break; // 行尾续行
                default: out += next; // \/ \\ \' \" 等：转义的那个字符本身
            }
        }
        return fail('字符串没有结束');
    }

    function key(): string {
        const ch = source[pos];
        if (ch === '"' || ch === "'") return string();
        const start = pos;
        while (pos < source.length && /[A-Za-z0-9_$]/.test(source[pos]!)) pos++;
        if (pos === start) fail('键名不对');
        return source.slice(start, pos);
    }

    function value(depth: number): unknown {
        if (depth > MAX_DEPTH) fail('嵌套太深');
        skip();
        const ch = source[pos];
        if (ch === '{') {
            pos++;
            const object: Record<string, unknown> = {};
            for (;;) {
                skip();
                if (source[pos] === '}') { pos++; return object; }
                const name = key();
                skip();
                if (source[pos++] !== ':') fail('缺冒号');
                object[name] = value(depth + 1);
                skip();
                if (source[pos] === ',') { pos++; continue; }
                if (source[pos] === '}') { pos++; return object; }
                fail('对象里缺逗号');
            }
        }
        if (ch === '[') {
            pos++;
            const array: unknown[] = [];
            for (;;) {
                skip();
                if (source[pos] === ']') { pos++; return array; }
                array.push(value(depth + 1));
                skip();
                if (source[pos] === ',') { pos++; continue; }
                if (source[pos] === ']') { pos++; return array; }
                fail('数组里缺逗号');
            }
        }
        if (ch === '"' || ch === "'") return string();
        const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|undefined)/.exec(source.slice(pos, pos + 40));
        if (!word) return fail('认不出的值');
        pos += word[0].length;
        switch (word[0]) {
            case 'true': return true;
            case 'false': return false;
            case 'null': return null;
            case 'undefined': return undefined;
            default: return Number(word[0]);
        }
    }

    const result = value(0);
    skip();
    if (pos < source.length) fail('后面还有多余的东西');
    return result;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/** html 片段 → 一行字：表情图片 <img alt="[xxx]"> 留下 alt，其余标签去掉，实体还原，空白压成一个 */
export function htmlToText(html: string): string {
    return html
        .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, alt: string) => alt)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, entity => ENTITIES[entity] ?? entity)
        .replace(/\s+/g, ' ')
        .trim();
}

/** 一条说说的正文在 html 里 class 含 f-info 的那个 div 里（10-25 实测）。找不到就是没有正文（只发图 / 不是说说） */
export function postTextFromHtml(html: string): string {
    const start = html.search(/<div[^>]*class="[^"]*\bf-info\b[^"]*"[^>]*>/i);
    if (start < 0) return '';
    const open = html.slice(start).match(/^<div[^>]*>/i)![0];
    // 数 div 的开合，取出这个 div 的内容
    let depth = 1;
    let index = start + open.length;
    const tag = /<(\/?)div\b[^>]*>/gi;
    tag.lastIndex = index;
    for (let match = tag.exec(html); match; match = tag.exec(html)) {
        depth += match[1] ? -1 : 1;
        if (depth === 0) return htmlToText(html.slice(start + open.length, match.index));
        index = match.index;
    }
    return htmlToText(html.slice(start + open.length, index));
}

function imageCountFromHtml(html: string): number {
    // 配图在 img-box 里（10-25 的样本里只有广告带这个块，她自己的说说都没配图——没有真的配图说说验证过，数不准也不影响正文）
    const block = html.match(/<div[^>]*class="[^"]*\bimg-box\b[^"]*"[^>]*>[\s\S]*?<\/div>/i)?.[0] ?? '';
    return (block.match(/<img\b/gi) ?? []).length;
}

export interface ParseFriendsFeedOptions {
    /** 过滤掉她自己发的（她知道自己发了什么，那是 describeSelf 的事） */
    selfUin?: number;
}

/**
 * 把 feeds3_html_more 的返回（JSONP + JS 字面量）解析成好友发的说说。
 * 广告（appid 非 311、opuin 为 0、带 adinfo）、没有正文的、她自己发的一律不收（转发的说说 10-25 没有真样本，按有正文就收）。读不出结构返回 undefined。
 */
export function parseFriendsFeed(text: string, options: ParseFriendsFeedOptions = {}): FriendPost[] | undefined {
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start < 0 || end <= start) return undefined;
    let root: unknown;
    try { root = parseJsLiteral(text.slice(start + 1, end)); } catch { return undefined; }
    const record = asRecord(root);
    if (!record || (typeof record.code === 'number' && record.code !== 0)) return undefined;
    const list = asRecord(record.data)?.data;
    if (!Array.isArray(list)) return undefined;
    const posts: FriendPost[] = [];
    for (const entry of list) {
        const item = asRecord(entry);
        if (!item) continue;
        if (String(item.appid) !== '311') continue;
        const uin = Number(item.opuin);
        if (!Number.isSafeInteger(uin) || uin <= 0 || uin === options.selfUin) continue;
        const html = typeof item.html === 'string' ? item.html : '';
        if (!html || /adinfo/i.test(html)) continue;
        const body = postTextFromHtml(html);
        if (!body) continue;
        const abs = Number(item.abstime);
        posts.push({
            id: typeof item.key === 'string' && item.key ? item.key : `${uin}-${abs}`,
            uin,
            ...(typeof item.nickname === 'string' && item.nickname ? { name: item.nickname } : {}),
            text: body,
            images: imageCountFromHtml(html),
            ...(Number.isFinite(abs) && abs > 0 ? { at: abs * 1000 } : {}),
        });
    }
    return posts;
}

const HOST = 'https://user.qzone.qq.com';

export function friendsFeedUrl(session: QzoneSession, page = 0): string {
    const params = new URLSearchParams({
        uin: String(session.uin ?? 0),
        scope: '0',
        view: '46',
        filter: 'all',
        flag: '1',
        applist: 'all',
        refresh: '0',
        aisort: '1',
        pagenum: String(page),
        g_tk: String(session.gtk),
        callback: '_preloadCallback',
        format: 'jsonp',
    });
    return `${HOST}/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?${params.toString()}`;
}

export interface ReadFriendsFeedOptions {
    session: QzoneSession;
    fetch?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

/** 读一页好友动态。网络错误、登录态过期、结构变了都返回 undefined；读到但里面没有好友的说说返回 [] */
export async function readFriendsFeed(options: ReadFriendsFeedOptions): Promise<FriendPost[] | undefined> {
    const doFetch = options.fetch ?? ((target: string, init: { headers: Record<string, string> }) => fetch(target, init));
    try {
        const response = await doFetch(friendsFeedUrl(options.session), {
            headers: {
                cookie: options.session.cookie,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                referer: 'https://user.qzone.qq.com/',
            },
        });
        if (!response.ok) return undefined;
        return parseFriendsFeed(await response.text(), options.session.uin !== undefined ? { selfUin: options.session.uin } : {});
    } catch {
        return undefined;
    }
}

