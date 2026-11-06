// 她翻 QQ 空间（「空友爱看」那种混着陌生人的推荐流），ADR 0142。
//
// 空间没有对外的「刷」接口（ADR 0083 已确认：投稿是客户端按钮，机器人投不了）。能拿到的只有 NapCat 的几个
// 扩展动作，而且名字在不同版本里不一样——所以这里按候选名逐个试，哪个能用记下来，全不能用就返回 undefined，
// 上层记一行「这台 NapCat 读不了空间」，不做任何假装。
//
// 读完只做两件事：① 给她一行「你刚才翻空间看到…」（进提示词，和 describeSelf 一个用法）；② 收进状态文件，
// 免得同一批反复当新的。点赞 / 评论不走这里，走 account.run（社交档，默认关）。

export interface QzoneItem {
    /** 说说 id（tid），去重和点赞都用它 */
    id: string;
    uin?: number;
    name?: string;
    text: string;
    images: number;
    at?: number;
    likes?: number;
    comments?: number;
}

export interface QzoneFeed {
    /** 哪个动作读出来的（排障用） */
    action: string;
    items: QzoneItem[];
}

export type AccountCall = (action: string, params: Record<string, unknown>) => Promise<unknown>;

/** NapCat 各版本里读空间动态可能用的动作名；按顺序试，第一个有数据/不报错的算 */
export const QZONE_READ_ACTIONS = ['get_qzone_msg_list', 'get_qzone_feeds', 'qzone_get_feeds', 'get_qzone_recent'] as const;

export interface ReadFeedOptions {
    count?: number;
    actions?: readonly string[];
}

/**
 * 读一页空间动态。全部候选都失败（动作不存在 / 没登录态）返回 undefined。
 * 先试默认候选；给了 actions 就只试这些（探针用）。
 */
export async function readQzoneFeed(call: AccountCall, options: ReadFeedOptions = {}): Promise<QzoneFeed | undefined> {
    const count = options.count ?? 10;
    const actions = options.actions ?? QZONE_READ_ACTIONS;
    for (const action of actions) {
        try {
            const data = await call(action, { count, pos: 0 });
            const items = normalizeQzoneFeed(data);
            // 动作能用但这一页是空的：也算读到了，别去试下一个名字（免得重复算）
            if (items.length || data !== undefined) return { action, items };
        } catch { /* 这个动作没有，试下一个 */ }
    }
    return undefined;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
        const n = typeof value === 'number' ? value
            : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
        if (Number.isFinite(n)) return n;
    }
    return undefined;
}

function imageCount(raw: unknown): number {
    if (Array.isArray(raw)) return raw.length;
    if (typeof raw === 'string' && raw) {
        // NapCat 有的版本给的是 JSON 字符串或逗号分隔的图片地址
        const text = raw.trim();
        if (text.startsWith('[')) {
            try { const parsed: unknown = JSON.parse(text); return Array.isArray(parsed) ? parsed.length : 1; } catch { return 1; }
        }
        return text.split(',').filter(Boolean).length;
    }
    return 0;
}

/** 从各个版本的数据形状里认出「一条说说」。认不出正文就跳过（只点赞不写字的那种） */
export function normalizeQzoneFeed(data: unknown): QzoneItem[] {
    const root = asRecord(data);
    const raw = Array.isArray(data) ? data
        : root ? (root.msgList ?? root.list ?? root.feeds ?? root.data ?? []) : [];
    if (!Array.isArray(raw)) return [];
    const items: QzoneItem[] = [];
    for (const entry of raw) {
        const item = asRecord(entry);
        if (!item) continue;
        const text = firstString(item.content, item.contentText, item.summary, item.text, item.title) ?? '';
        const id = firstString(item.tid, item.id, item.feedId, item.unikey) ?? (firstNumber(item.tid, item.id)?.toString() ?? '');
        if (!id) continue;
        if (!text) continue;
        const rawTime = firstNumber(item.createTime, item.create_time, item.time, item.created);
        const at = rawTime === undefined ? undefined : rawTime < 1e12 ? rawTime * 1000 : rawTime;
        const uin = firstNumber(item.uin, item.qq, item.userId, item.user_id);
        items.push({
            id,
            ...(uin !== undefined ? { uin } : {}),
            ...(firstString(item.nickname, item.name, item.nickName) ? { name: firstString(item.nickname, item.name, item.nickName)! } : {}),
            text,
            images: imageCount(item.pic ?? item.pics ?? item.images ?? item.photo),
            ...(at !== undefined ? { at } : {}),
            ...(firstNumber(item.likeCount, item.likeNum, item.likes) !== undefined ? { likes: firstNumber(item.likeCount, item.likeNum, item.likes)! } : {}),
            ...(firstNumber(item.commentCount, item.commentNum, item.comments) !== undefined ? { comments: firstNumber(item.commentCount, item.commentNum, item.comments)! } : {}),
        });
        if (items.length >= 20) break;
    }
    return items;
}

const MAX_QUOTE = 40;

/**
 * 给她看的一行：「你刚才翻了会儿空间，刷到：①「…」②「…」③「…」（一共 8 条）」。
 * 只留文字（图和别人的名字都不进提示词），同一批里完全不重复的不再列；一条都没有返回 undefined。
 */
export function feedDigest(feed: QzoneFeed | undefined, limit = 3, prefix = '你刚才翻了会儿 QQ 空间，刷到：'): string | undefined {
    if (!feed || !feed.items.length) return undefined;
    const seen = new Set<string>();
    const quotes: string[] = [];
    for (const item of feed.items) {
        const text = item.text.replace(/\s+/g, ' ').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        quotes.push(`「${text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text}」`);
        if (quotes.length >= limit) break;
    }
    if (!quotes.length) return undefined;
    return `${prefix}${quotes.join('、')}（这一页一共 ${feed.items.length} 条）`;
}

/** 点赞 / 评论的动作名候选（和读一样，按版本试）；账号层会再过一遍闸 */
export const QZONE_LIKE_ACTIONS = ['like_qzone_msg', 'set_qzone_like'] as const;
export const QZONE_COMMENT_ACTIONS = ['comment_qzone_msg', 'send_qzone_comment'] as const;
