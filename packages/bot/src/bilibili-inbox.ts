// 她的 B 站「收件箱」（ADR 0168 第 3 期的只读层）：回复、@、收到的赞、系统通知，合成一份能看的清单。
// 回复（msgfeed/reply）和系统通知已经在 bilibili-account.ts 里；这里补 **@** 和 **赞** 的解析 + 四类合并。
// 这个模块自己不发请求（getJson 由调用方给）：线上用她登录后的 request，测试用假数据；解析失败返回空，不假装。
// 注意：msgfeed 接口都要登录；匿名调会是 code -101，调用方按「没登录」处理，不要当「没有新消息」。

export type InboxKind = 'reply' | 'mention' | 'like' | 'system';

export interface InboxEntry {
    kind: InboxKind;
    /** 去重用的 id（同 kind 内唯一） */
    id: string;
    /** 谁：uid + 昵称（没有就空） */
    uid?: number;
    name?: string;
    /** 对方说的话 / 通知正文（已去 HTML、压空白、截 80 字） */
    text: string;
    /** 毫秒；读不出来是 0 */
    at: number;
    /** 视频 / 动态的链接（能拼出来才有） */
    link?: string;
}

type FetchJson = (url: string) => Promise<unknown>;

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const idOf = (value: unknown): string => (typeof value === 'string' && value ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '');

const stripHtml = (text: string): string => text.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
const secondsToMs = (value: unknown): number => {
    const seconds = num(value);
    return seconds > 0 ? (seconds < 1e12 ? seconds * 1000 : seconds) : 0;
};
const videoLink = (uri: unknown): string | undefined => {
    const text = str(uri);
    if (/^BV[0-9A-Za-z]{10}$/.test(text)) return `https://www.bilibili.com/video/${text}`;
    const match = /(?:bilibili\.com\/video\/)?(BV[0-9A-Za-z]{10})/.exec(text);
    return match ? `https://www.bilibili.com/video/${match[1]}` : undefined;
};

/** @我的（x/msgfeed/at）→ 条目；只收有正文和人的 */
export function parseMentions(data: unknown): InboxEntry[] {
    const entries: InboxEntry[] = [];
    for (const raw of arr(rec(data).items)) {
        const item = rec(raw);
        const user = rec(item.user);
        const detail = rec(item.item);
        const text = stripHtml(str(detail.source_content) || str(detail.content) || str(item.title)).slice(0, 80);
        const id = idOf(item.id) || idOf(detail.source_id);
        const uid = num(user.mid);
        // 没有 id、没有正文、也没有人：不是一条能看的消息
        if (!id || !text || (!uid && !str(user.nickname))) continue;
        const link = videoLink(detail.uri) ?? videoLink(detail.source_id);
        entries.push({ kind: 'mention', id, ...(uid ? { uid } : {}), ...(str(user.nickname) ? { name: str(user.nickname) } : {}), text, at: secondsToMs(item.at_time), ...(link ? { link } : {}) });
        if (entries.length >= 20) break;
    }
    return entries;
}

/** 收到的赞（x/msgfeed/like）→ 条目；赞没有正文，用「赞了你的评论/视频」 */
export function parseLikes(data: unknown): InboxEntry[] {
    const root = rec(data);
    const list = arr(rec(root.total).items).length ? arr(rec(root.total).items) : arr(root.items);
    const entries: InboxEntry[] = [];
    for (const raw of list) {
        const item = rec(raw);
        const users = arr(item.users).map(rec);
        const first = users[0] ?? rec(item.user);
        const uid = num(first.mid);
        const name = str(first.nickname);
        const detail = rec(item.item);
        const id = idOf(item.id) || `${num(item.like_time)}-${uid}`;
        if (!id) continue;
        const count = Math.max(1, num(item.counts) || users.length);
        const link = videoLink(detail.uri);
        entries.push({
            kind: 'like', id, ...(uid ? { uid } : {}), ...(name ? { name } : {}),
            text: `赞了你的${detail.type === 'reply' ? '评论' : '视频'}${count > 1 ? `（共 ${count} 个赞）` : ''}`.slice(0, 80),
            at: secondsToMs(item.like_time), ...(link ? { link } : {}),
        });
        if (entries.length >= 20) break;
    }
    return entries;
}

/** 四类合起来：同 kind 同 id 去重（留新的），按时间倒序；没有时间的排最后 */
export function mergeInbox(entries: readonly InboxEntry[]): InboxEntry[] {
    const seen = new Map<string, InboxEntry>();
    for (const entry of entries) {
        const key = `${entry.kind}:${entry.id}`;
        const previous = seen.get(key);
        if (!previous || (entry.at || 0) > (previous.at || 0)) seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** 一句概览（日志 / 面板用，不含正文）：「3 条回复、2 个 @、5 个赞、1 条系统通知」 */
export function inboxLine(entries: readonly InboxEntry[]): string {
    const count = (kind: InboxKind): number => entries.filter(entry => entry.kind === kind).length;
    const parts = [
        count('reply') ? `${count('reply')} 条回复` : '',
        count('mention') ? `${count('mention')} 个 @` : '',
        count('like') ? `${count('like')} 个赞` : '',
        count('system') ? `${count('system')} 条系统通知` : '',
    ].filter(Boolean);
    return parts.length ? parts.join('、') : '没有新消息';
}

const DATA_CODE_LOGIN = -101;
const DATA_CODE_LOGIN2 = -104;

/** 拿 @（要她登录）。未登录返回 undefined，调用方记「要登录」而不是「没有新消息」 */
export async function fetchMentionFeed(getJson: FetchJson): Promise<InboxEntry[] | undefined> {
    try {
        return parseMentions(await getJson('https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web'));
    } catch (error) {
        if (error instanceof Error && new RegExp(`code ${DATA_CODE_LOGIN}\\b|code ${DATA_CODE_LOGIN2}\\b`).test(error.message)) return undefined;
        return undefined;
    }
}

/** 拿赞（要她登录）；未登录 / 出错返回 undefined */
export async function fetchLikeFeed(getJson: FetchJson): Promise<InboxEntry[] | undefined> {
    try {
        return parseLikes(await getJson('https://api.bilibili.com/x/msgfeed/like?platform=web&build=0&mobi_app=web'));
    } catch {
        return undefined;
    }
}
