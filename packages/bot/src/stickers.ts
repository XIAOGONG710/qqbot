// 图片表情收藏（ADR 0063）：
// - 候选来自 QQ 账号已有的自定义表情，以及名单联系人发来的图片表情；
// - 先看图、按林梦瑶稳定的偏好判断要不要留，再下载到 dataDir/stickers；
// - 回复模型只能从提示词列出的稳定编号里选，输出单独一行 <sticker:编号>，未知或混在文字里的指令不会发送；
// - 收藏任务后台串行，不挡住正常收消息和回复。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logBody } from './sensitive.ts';
import type { AppConfig } from './config.ts';
import type { CrisisLevel } from './emotion/crisis.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { chatCompletion } from './llm.ts';
import { isSticker, type ImageDescriber } from './vision/media.ts';
import type { Segment } from './onebot.ts';
import type { OpenAIMessage } from './prompt.ts';
import { detectImageType, fetchRemoteImage, imageDataUrl, type DownloadedImage } from './vision/safe-image.ts';

export const STICKER_MAX_BYTES = 5 * 1024 * 1024;
export const STICKER_PROMPT_MAX = 12;
/**
 * 代码定哪几轮发图片表情（和 expression.ts 的长短一样按他这句话的哈希抽签）：他这句话里有明确的反应（哈哈、抱抱、晚安、无语、吃……，见 REACTIONS）
 * 且允许发的轮次里，这么多发一个；没有明确反应的轮次不发（随便挑一张常常不搭）。
 * 真人朋友之间约 9% 的轮里带表情包（调研 14.2）；最近 8 条回复里发过就不发（imageStickerAllowance）。
 * 10-19 题库回放（73 个真人聊天场景、26 个允许发的）：不抽签让她自己决定，24 次最合适的场合（晚安、哈哈哈、抱抱）0 次发——
 * 从一长串里挑编号对她太费劲，她拿 QQ 小黄脸就够了；抽签 + 按他这句话挑 8 张 + 写明「这一轮要发」：允许的 26 个里发了 20 个，
 * 有明确反应的（晚安、抱抱、吃）选得贴，没有明确反应的（「知道啦」「哦哦 好」）选得不搭。
 */
export const STICKER_TURN_CHANCE = 0.7;
/**
 * 抽到发图片表情的轮次里，只发表情、不写文字的比例（ADR 0099）。他自己的线上话：437 轮里 6% 只有表情（动画表情或纯 QQ 小表情）、10% 带表情，
 * 也就是发表情的轮次里约六成是纯表情；她线上 437 轮里只有表情 1 轮、带表情 4 轮。取 0.5：她的表情本来就少，偏保守
 */
export const STICKER_ONLY_SHARE = 0.5;
/** 抽到的轮次给她看几张（按他这句话挑出来的，最合适的在前） */
export const STICKER_SHORTLIST = 8;

/** 他这句话里看出来的反应 → 货架标签 / 描述里要找的词（命中越多越靠前） */
const REACTIONS: { cue: RegExp; words: string[] }[] = [
    // 他发来的是个表情：人对方发表情之后，下一条有 17–23% 回表情（调研 14.2）
    { cue: /[(?:动画)?表情]/, words: ['表情包', '可爱', '搞笑', '日常'] },
    { cue: /哈哈|笑死|hh|笑哭|乐死|搞笑|绝了|太好笑/i, words: ['搞笑', '开心', '大笑', '得意', '调侃', '欠欠', '庆祝', '欢快'] },
    { cue: /想你|抱抱|亲亲|爱你|么么|贴贴|心里.{0,3}软|宝宝|老婆|老公/, words: ['可爱', '撒娇', '爱心', '亲亲', '抱抱', '害羞', '暖', '甜', '委屈', '脸红'] },
    { cue: /晚安|睡了|睡吧|先睡|困了|困死|眯一会/, words: ['晚安', '睡', '困', '月亮', '休息'] },
    { cue: /无语|离谱|服了|什么鬼|拉倒|算了|滚|气死|烦|讨厌|崩溃/, words: ['无语', '无奈', '嫌弃', '崩溃', '烦躁', '欠欠', '摆烂'] },
    { cue: /真的假的|不会吧|天哪|卧槽|我去|啊[？?]|！{2,}|!{2,}/, words: ['震惊', '惊讶', '困惑', '装傻', '疑惑', '恍然大悟'] },
    { cue: /吃|饿|奶茶|火锅|外卖|好喝|好吃|烧烤|蛋糕/, words: ['吃', '美食', '馋', '奶茶', '喝', '干饭'] },
    { cue: /好的|行吧|收到|知道了|嗯嗯|可以|没问题/, words: ['好的', '点头', '收到', '日常', '表情包'] },
    { cue: /厉害|牛|棒|强|夸|优秀|赢了|拿下/, words: ['点赞', '夸', '厉害', '鼓掌', '庆祝'] },
];
/** 没看出特别的反应时找这些（通用、日常的） */
const GENERIC_WORDS = ['日常', '可爱', '搞笑', '表情包', '聊天'];

/** 他这句话里有没有明确的反应（哈哈、抱抱、晚安、无语、吃……）：没有就不抽签发表情 */
export function stickerCued(text: string): boolean {
    return REACTIONS.some(r => r.cue.test(text));
}

/** 他这句话的反应词（没看出来就是通用的） */
export function stickerReactionWords(text: string): string[] {
    const words = REACTIONS.filter(r => r.cue.test(text)).flatMap(r => r.words);
    return words.length ? [...new Set(words)] : GENERIC_WORDS;
}

/** 按他这句话给货架排序：标签和描述里命中的反应词越多越靠前，同分的少用的在前；纯函数 */
export function rankStickers(entries: readonly StickerEntry[], text: string): StickerEntry[] {
    const words = stickerReactionWords(text);
    const score = (entry: StickerEntry) => words.filter(word => entry.tags.includes(word) || entry.description.includes(word)).length;
    return [...entries].sort((a, b) => score(b) - score(a) || a.used - b.used || Date.parse(a.lastUsedAt ?? a.createdAt) - Date.parse(b.lastUsedAt ?? b.createdAt));
}

/** 抽到发图片表情的这一轮，是不是只发表情、不写文字（按他最后一条的时间和内容定，同一句每次一样；和 stickerTurn 的抽签互不影响） */
export function stickerOnlyTurn(history: readonly { role: 'user' | 'assistant'; content: string; time?: string }[], chance = STICKER_ONLY_SHARE, salt = 'sticker only'): boolean {
    const last = history.findLast(message => message.role === 'user');
    if (!last) return false;
    let hash = 0x811c9dc5;
    for (const char of `${last.time ?? ''} ${last.content} ${salt}`) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    return ((hash >>> 0) / 0x1_0000_0000) < chance;
}

/** 这一轮抽没抽到发图片表情（按他最后一条的时间和内容定，同一句每次一样） */
export function stickerTurn(history: readonly { role: 'user' | 'assistant'; content: string; time?: string }[], chance = STICKER_TURN_CHANCE, salt = 'sticker'): boolean {
    const last = history.findLast(message => message.role === 'user');
    if (!last) return false;
    let hash = 0x811c9dc5;
    for (const char of `${last.time ?? ''} ${last.content} ${salt}`) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    return ((hash >>> 0) / 0x1_0000_0000) < chance;
}
export const STICKER_DISCOVERY_PER_RUN = 3;
export const STICKER_DISCOVERY_INTERVAL_MS = 60 * 60_000;
/** 公开目录候选每天最多审看几个 */
export const STICKER_TREND_PER_DAY = 3;
/** 每次发现最多补同步几张进 QQ 收藏 */
export const STICKER_FAVORITES_PER_SYNC = 10;
// 10-12 19:26 用户一口气发来 60 多张自己常用的，80 张的上限当场把存货全挤掉了；QQ 收藏里反正只加不删，本地多留一些让她选择更多
export const STICKER_LIBRARY_MAX = 200;
export const STICKER_REPLY_WINDOW = 8;
export const STICKER_HISTORY_PREFIX = '她发了个表情包：';
const INDEX_VERSION = 1;
const TOKEN = /<sticker:([a-f0-9]{12})>/gi;
const EXACT_TOKEN = /^<sticker:([a-f0-9]{12})>$/i;
/** 模型不能用文字冒充真的图片消息；真实发送后的历史才会写入可读描述。 */
const FAKE_STICKER_DESCRIPTION = /^\s*(?:(?:她|我)?发了?(?:一?个)?表情包[：:].+|[\[【（(]表情包[^\]】）)]*[\]】）)])\s*$/;

/** 没有发送权限的档位也不能把内部编号或文字占位符直接发给对方。 */
export function stripStickerArtifacts(reply: string): string {
    return reply.split('\n').flatMap(line => {
        if (FAKE_STICKER_DESCRIPTION.test(line)) return [];
        const plain = line.replace(TOKEN, '').trim();
        return plain ? [plain] : [];
    }).join('\n').trim();
}

/** 图片表情是调味，不在需要认真回应、刚被吵醒或最近已经用过时出现。 */
export function imageStickerAllowance(
    history: readonly Pick<StoredMessage, 'role' | 'content'>[],
    intent?: string,
    woken = false,
    crisis?: CrisisLevel,
): { allowed: boolean; reason?: string } {
    if (crisis) return { allowed: false, reason: '危机辅助响应' };
    if (woken) return { allowed: false, reason: '刚被消息吵醒' };
    const recentReplies = history.filter(message => message.role === 'assistant').slice(-STICKER_REPLY_WINDOW);
    if (recentReplies.some(message => message.content.startsWith(STICKER_HISTORY_PREFIX))) {
        return { allowed: false, reason: `最近 ${STICKER_REPLY_WINDOW} 条回复里已经发过图片表情` };
    }
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const current = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    // 「在吗」「在干嘛」「睡了吗」这类招呼式的问句不算“直接提问”：真人收到这种话常常回个表情（10-22：线上 52 次图片表情判定里 31 次被“他问了直接问题”挡掉，其中多半是测试里的真问题，但招呼式的也在里面）
    const greeting = /^(?:在吗|在不在|在干嘛|干嘛呢|干嘛|干啥呢|睡了吗|睡了没|吃了吗|吃了没|起了吗|醒了吗|忙吗|想我没|想我吗)[呀啊吧呢嘛\s]*[？?]*$/.test(current.trim());
    if (!greeting && (/[？?]|(?:^|[，。！!\s])(?:怎么|为什么|咋|多少|几点|哪里|哪儿|谁|什么|是不是|有没有)/.test(current)
        || /(?:吗|嘛|呢)[？?。！!\s]*$/.test(current))) {
        return { allowed: false, reason: '他这一轮问了直接问题' };
    }
    // 「回应他刚说的那件事」是最常见的意图行（他说自己的事、先对这件事有个反应）：一个表情就是一种反应，原来整条挡掉，所以图片表情判定里 11 次“要认真回应”几乎全是它；
    // 「他刚说了件好事」庆祝类的表情也自然。挡住的只剩要认真接的：想看照片、难过、直接提问、危机。有没有合适的表情还要看他这句话有没有明确的反应（stickerCued），没有照旧不发
    if (intent && /他想看照片|先接住他此刻的情绪|先直接回答他刚问的|想伤害自己、不想活/.test(intent)) {
        return { allowed: false, reason: '这一轮要认真回应他说的事' };
    }
    if (/(?:面试|考试|答辩|作业|工作|老板|老师|导师|家里|医院|生病|受伤|事故|出事|分手|吵架|转账|欠钱|难过|伤心|焦虑|害怕|疼|痛|累死|烦死)/.test(current)) {
        return { allowed: false, reason: '他在认真说事' };
    }
    return { allowed: true };
}

export interface StickerSource {
    kind: 'received' | 'qq-custom' | 'inbox' | 'web' | 'bqb' | 'bili';
    from?: number;
    messageId?: number;
    name?: string;
}

export interface StickerEntry {
    id: string;
    file: string;
    description: string;
    tags: string[];
    source: StickerSource;
    createdAt: string;
    used: number;
    lastUsedAt?: string;
    /** 已经同步进 QQ 账号「收藏的表情」；md5 是文件内容的大写十六进制，用来认出 QQ 收藏池里哪些是我们自己同步进去的 */
    qq?: { md5: string };
}

/** QQ 账号自己的「收藏的表情」（NapCat 的 add_custom_face / fetch_custom_face_detail） */
export interface StickerFavorites {
    /** 把本地图片加进 QQ 收藏，返回文件内容的 md5（大写十六进制）；失败抛错。只加不删：本地收藏淘汰了，QQ 收藏里仍然留着（用户 10-12：「存着就行」） */
    add(file: string): Promise<string>;
}

interface StickerIndex {
    version: typeof INDEX_VERSION;
    entries: StickerEntry[];
    /** 已看过的 URL（无论收没收藏）。只留最近一批，避免每次重启重新付一次看图费用，也能继续往表情池后面翻。 */
    seen: string[];
    /** 公开目录候选今天已经审看了几个（按本地日期，跨重启） */
    trend?: { day: string; count: number };
}

export interface StickerDecision {
    keep: boolean;
    description: string;
    tags: string[];
}

export type DownloadedSticker = DownloadedImage;

export interface StickerShelfOptions {
    dir: string;
    describe: ImageDescriber['describe'];
    decide: (description: string, summary?: string) => Promise<StickerDecision>;
    download?: (url: string) => Promise<DownloadedSticker>;
    /** 持续更新的公开网络候选源；与导入箱、QQ 自定义表情共用每小时预算。 */
    trendDiscover?: () => Promise<string[]>;
    trendPerDay?: number;
    /** 看完描述、做收藏判断之前的筛（ADR 0132：B 站评论区图片里的真人照片 / 截图 / 广告）；返回不收的原因，通过返回 undefined */
    screen?: (description: string, source: StickerSource) => string | undefined;
    /** QQ 账号已有的自定义表情。 */
    /** knownMd5：已经同步进 QQ 收藏的那些（大写 md5）；QQ 收藏池里有它们，别再当新候选看一遍 */
    discover?: (knownMd5: ReadonlySet<string>) => Promise<string[]>;
    /** 她收藏的每一张同步进 QQ 账号的「收藏的表情」（只加不删）；不给就只存本地 */
    favorites?: StickerFavorites;
    /** 两次 QQ 收藏操作之间隔多久（毫秒），像人一样一张张存 */
    favoritesGapMs?: number;
    /** 每次发现（启动和每小时）最多补同步几张还没进 QQ 收藏的 */
    favoritesPerSync?: number;
    log: (message: string) => void;
    now?: () => Date;
    discoveryPerRun?: number;
    discoveryIntervalMs?: number;
    libraryMax?: number;
}

export interface StickerShelf {
    /** 从一条收到的 OneBot 消息里挑图片表情；后台调用方不用等。 */
    consider(message: Segment[] | string, source: Omit<StickerSource, 'kind'>): Promise<void>;
    /** 从导入箱、公开网络候选源和 QQ 自定义表情池看几个新的候选。 */
    discover(): Promise<void>;
    /** 运行时换掉“持续更新的公开网络候选源”（ADR 0132：app 起来、她的 B 站号能用了以后换成 B 站）；make 拿到原来的来源，可以当兜底。perDay 不给就沿用 */
    setTrend?(make: (previous?: () => Promise<string[]>) => () => Promise<string[]>, perDay?: number): void;
    /**
     * 给回复模型看的本地收藏清单。不传 context：旧办法，最久没用的 12 张；
     * 传 context（他这一轮说的话）：抽到发表情的这一轮，按他这句话挑 STICKER_SHORTLIST 张最合适的，并写明这一轮要发一个。
     */
    prompt(context?: { text: string; only?: boolean }): string | undefined;
    /** 清掉未知、混在文字里的、以及同一轮第二个图片表情指令。 */
    clean(reply: string, allow?: boolean): string;
    /** 一整个气泡是不是一个可发送的收藏表情。 */
    resolve(text: string): StickerEntry | undefined;
    /** 真实图片发出后写入聊天记录的可读内容；普通文字原样返回。 */
    history(text: string): string;
    used(id: string): void;
    status(): { count: number };
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const emptyIndex = (): StickerIndex => ({ version: INDEX_VERSION, entries: [], seen: [] });

/** 图片 URL 可能带短期 rkey；只把它作为本次去重线索，不写进提示词和聊天记录。 */
function sourceKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

export async function downloadSticker(url: string): Promise<DownloadedSticker> {
    return fetchRemoteImage(url, { timeoutMs: 8000, maxBytes: STICKER_MAX_BYTES });
}

const extension: Record<DownloadedSticker['type'], string> = {
    'image/gif': 'gif', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};

function normalizedDecision(value: StickerDecision): StickerDecision {
    const description = value.description.replace(/\s+/g, ' ').trim().slice(0, 80);
    const tags = [...new Set(value.tags.map(tag => String(tag).replace(/\s+/g, '').slice(0, 8)).filter(Boolean))].slice(0, 5);
    return { keep: Boolean(value.keep && description), description, tags };
}

export function stickerShelf(options: StickerShelfOptions): StickerShelf {
    mkdirSync(options.dir, { recursive: true });
    const inboxDir = join(options.dir, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    mkdirSync(join(inboxDir, 'wechat'), { recursive: true });
    mkdirSync(join(inboxDir, 'web'), { recursive: true });
    const indexPath = join(options.dir, 'index.json');
    const loaded = readJsonOr<StickerIndex>(indexPath, emptyIndex(), options.log);
    const index: StickerIndex = loaded.version === INDEX_VERSION && Array.isArray(loaded.entries) && Array.isArray(loaded.seen) ? loaded : emptyIndex();
    const now = options.now ?? (() => new Date());
    const download = options.download ?? downloadSticker;
    const pending = new Set<string>();
    let queue = Promise.resolve();
    let lastDiscoveredAt: number | undefined;
    const libraryMax = options.libraryMax ?? STICKER_LIBRARY_MAX;
    let trendSource = options.trendDiscover;
    let trendPerDay = options.trendPerDay;

    const persist = () => writeJsonAtomic(indexPath, index);
    // QQ 收藏的操作串行、隔几秒一个：一张张存，不一股脑发；失败只记日志，本地收藏不受影响，下次发现时补。
    let favQueue = Promise.resolve();
    const favGap = options.favoritesGapMs ?? 2000;
    const favorite = (task: () => Promise<void>) => {
        favQueue = favQueue.then(task).catch(error => options.log(`图片表情：QQ 收藏操作失败（${error instanceof Error ? error.message : String(error)}）`))
            .then(() => favGap > 0 ? new Promise<void>(resolve => setTimeout(resolve, favGap)) : undefined);
        return favQueue;
    };
    // batch：补同步时一批里有一张失败（比如 QQ 收藏满了），这一批剩下的就不再试，免得一小时刷十条同样的失败日志
    const mirror = (entry: StickerEntry, batch?: { halted: boolean }) => favorite(async () => {
        if (!options.favorites || entry.qq || batch?.halted || !index.entries.includes(entry)) return;
        const file = resolve(options.dir, entry.file);
        if (!existsSync(file)) return;
        try {
            entry.qq = { md5: (await options.favorites.add(file)).toUpperCase() };
        } catch (error) {
            if (batch) batch.halted = true;
            throw error;
        }
        persist();
        options.log(`图片表情：已加进 QQ 收藏（${entry.id}）`);
    });
    const inboxKey = (path: string) => {
        const stats = statSync(path);
        return sourceKey(`inbox:${path}:${stats.size}:${stats.mtimeMs}`);
    };
    const inboxFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(item => {
        const path = join(dir, item.name);
        if (item.isDirectory()) return inboxFiles(path);
        return item.isFile() && item.name.toLowerCase() !== 'urls.txt' ? [path] : [];
    });
    const enqueue = (url: string, summary: string | undefined, source: StickerSource) => {
        const key = sourceKey(url);
        if (pending.has(key) || index.seen.includes(key)) return Promise.resolve();
        pending.add(key);
        const task = queue.then(() => considerOne(url, summary, source))
            .catch(error => options.log(`图片表情：候选处理失败（${error instanceof Error ? error.message : String(error)}）`))
            .finally(() => pending.delete(key));
        queue = task;
        return task;
    };

    async function considerOne(url: string, summary: string | undefined, source: StickerSource): Promise<void> {
        const key = sourceKey(url);
        // Download once through the SSRF/size guard; the model sees the same bytes we may keep.
        const image = await download(url);
        const description = (await options.describe({ url, dataUrl: imageDataUrl(image) })).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!description) return reject(key, '看不清内容');
        const screened = options.screen?.(description, source);
        if (screened) return reject(key, `${screened}（${description}）`);
        const decision = normalizedDecision(await options.decide(description, summary));
        if (!decision.keep) return reject(key, `不收（${decision.description || description}）`);
        keep(key, image, decision, source);
    }

    async function considerInbox(path: string): Promise<void> {
        const key = inboxKey(path);
        if (pending.has(key) || index.seen.includes(key)) return;
        pending.add(key);
        try {
            const bytes = new Uint8Array(readFileSync(path));
            if (!bytes.length || bytes.length > STICKER_MAX_BYTES) return reject(key, `${basename(path)} 为空或超过 5 MB`);
            const type = detectImageType(bytes);
            if (!type) return reject(key, `${basename(path)} 不是支持的 PNG/JPEG/GIF/WebP`);
            const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
            const description = (await options.describe({ url: dataUrl, file: path, dataUrl })).replace(/\s+/g, ' ').trim().slice(0, 120);
            if (!description) return reject(key, `${basename(path)} 看不清内容`);
            const decision = normalizedDecision(await options.decide(description, basename(path)));
            if (!decision.keep) return reject(key, `不收 ${basename(path)}（${decision.description || description}）`);
            keep(key, { bytes, type }, decision, { kind: 'inbox', name: basename(path) });
        } finally {
            pending.delete(key);
        }
    }

    function keep(key: string, image: DownloadedSticker, decision: StickerDecision, source: StickerSource): void {
        const hash = createHash('sha256').update(image.bytes).digest('hex');
        const id = hash.slice(0, 12);
        const existing = index.entries.find(entry => entry.id === id);
        if (existing) {
            markSeen(key);
            persist();
            options.log(`图片表情：已经收藏过 ${existing.description}`);
            return;
        }
        if (index.entries.length >= libraryMax) {
            const victim = [...index.entries].sort((a, b) => Date.parse(a.lastUsedAt ?? a.createdAt) - Date.parse(b.lastUsedAt ?? b.createdAt))[0]!;
            index.entries.splice(index.entries.indexOf(victim), 1);
            rmSync(join(options.dir, victim.file), { force: true });
            options.log(`图片表情：收藏已到 ${libraryMax} 个，淘汰最久没用的 ${victim.description}（${victim.id}）`);
        }
        const name = `${id}.${extension[image.type]}`;
        const target = join(options.dir, name);
        if (!existsSync(target)) {
            const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, image.bytes);
            renameSync(tmp, target);
        }
        const entry: StickerEntry = {
            id, file: name, description: decision.description, tags: decision.tags, source,
            createdAt: now().toISOString(), used: 0,
        };
        index.entries.push(entry);
        markSeen(key);
        persist();
        if (options.favorites) void mirror(entry);
        options.log(`图片表情：收藏 ${decision.description}（${id}${decision.tags.length ? `；${decision.tags.join('、')}` : ''}）`);
    }

    function reject(key: string, why: string): void {
        markSeen(key);
        persist();
        options.log(`图片表情：${why}`);
    }

    function markSeen(key: string): void {
        index.seen = [...index.seen.filter(item => item !== key), key].slice(-500);
    }

    const publicEntry = (entry: StickerEntry): StickerEntry => ({ ...entry, file: join(options.dir, entry.file) });
    return {
        consider(message, source) {
            if (typeof message === 'string') return Promise.resolve();
            const tasks = message.flatMap(segment => {
                const data = segment.data ?? {};
                if (segment.type !== 'image' || !isSticker(data)) return [];
                const url = typeof data.url === 'string' && data.url ? data.url : undefined;
                if (!url) return [];
                const summary = typeof data.summary === 'string' && data.summary ? data.summary : undefined;
                return [enqueue(url, summary, { kind: 'received', ...source })];
            });
            return Promise.all(tasks).then(() => undefined);
        },
        async discover() {
            const at = now().getTime();
            const interval = options.discoveryIntervalMs ?? STICKER_DISCOVERY_INTERVAL_MS;
            if (lastDiscoveredAt !== undefined && at - lastDiscoveredAt < interval) return;
            lastDiscoveredAt = at;
            let remaining = options.discoveryPerRun ?? STICKER_DISCOVERY_PER_RUN;
            // 还没进 QQ 收藏的（上线前就收了的、上次失败的）每次补几张，不一次全塞
            if (options.favorites) {
                const batch = { halted: false };
                for (const entry of index.entries.filter(item => !item.qq).slice(0, options.favoritesPerSync ?? STICKER_FAVORITES_PER_SYNC)) void mirror(entry, batch);
            }

            const local = inboxFiles(inboxDir).filter(path => {
                try { return !index.seen.includes(inboxKey(path)); } catch { return false; }
            }).sort();
            for (const path of local.slice(0, remaining)) {
                const task = queue.then(() => considerInbox(path))
                    .catch(error => options.log(`图片表情：导入 ${basename(path)} 失败（${error instanceof Error ? error.message : String(error)}）`));
                queue = task;
                await task;
                remaining--;
            }

            const manifest = join(inboxDir, 'urls.txt');
            const webUrls = existsSync(manifest)
                ? readFileSync(manifest, 'utf8').split(/\r?\n/).map(line => line.trim())
                    .filter(line => line && !line.startsWith('#') && /^https?:\/\//i.test(line))
                : [];
            for (const url of [...new Set(webUrls)].filter(url => !index.seen.includes(sourceKey(url))).slice(0, remaining)) {
                const name = (() => { try { return new URL(url).hostname; } catch { return 'urls.txt'; } })();
                await enqueue(url, undefined, { kind: 'web', name });
                remaining--;
            }

            // 公开目录的候选每天最多审看 trendPerDay 个（跨重启也算）：每小时 3 个的话，收藏一天多就被整批换掉，
            // 她就没有「自己的」表情包了。导入箱和 QQ 自定义表情不受这条限制（量本来就小）。
            const day = localDay(now());
            const trendLeft = (trendPerDay ?? STICKER_TREND_PER_DAY) - (index.trend?.day === day ? index.trend.count : 0);
            if (remaining > 0 && trendLeft > 0 && trendSource) {
                const urls = await trendSource();
                const fresh = [...new Set(urls)].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url) && !index.seen.includes(sourceKey(url)));
                for (const url of fresh.slice(0, Math.min(remaining, trendLeft))) {
                    index.trend = { day, count: (index.trend?.day === day ? index.trend.count : 0) + 1 };
                    persist();
                    // B 站的图都在 hdslb.com：官方表情包在 /bfs/emote/，评论区图片在别处（ADR 0132）
                    await enqueue(url, undefined, /(?:^|\.)hdslb\.com\//.test(url.replace(/^https?:\/\//, '')) ? { kind: 'bili', name: url.includes('/bfs/emote/') ? 'emote' : 'comment' } : { kind: 'bqb', name: 'ChineseBQB' });
                    remaining--;
                }
            }

            if (remaining > 0 && options.discover) {
                const urls = await options.discover(new Set(index.entries.flatMap(entry => entry.qq ? [entry.qq.md5] : [])));
                const fresh = [...new Set(urls)].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url) && !index.seen.includes(sourceKey(url)));
                for (const url of fresh.slice(0, remaining)) {
                    await enqueue(url, undefined, { kind: 'qq-custom' });
                }
            }
        },
        setTrend(make, perDay) {
            trendSource = make(trendSource);
            if (perDay !== undefined) trendPerDay = perDay;
        },
        prompt(context) {
            if (!index.entries.length) return undefined;
            const present = index.entries.filter(entry => existsSync(join(options.dir, entry.file)));
            if (context) {
                const shortlist = rankStickers(present, context.text).slice(0, STICKER_SHORTLIST);
                if (!shortlist.length) return undefined;
                const heading = context.only
                    ? '[这一轮你只发一个图片表情，不写任何文字：回复里只有一行 <sticker:编号>（这一行必须有，别的什么都不写），从下面按他这句话挑出来的几张里选最贴的一张，编号只能从下面选，不解释编号]\n'
                    : '[这一轮你要发一个图片表情：文字回完以后，另起一行单独写 <sticker:编号>（这一行必须有），从下面按他这句话挑出来的几张里选最贴的一张，编号只能从下面选，不解释编号]\n';
                return heading
                    + shortlist.map(entry => `- <sticker:${entry.id}>：${entry.description}${entry.tags.length ? `（${entry.tags.join('、')}）` : ''}`).join('\n');
            }
            const entries = present
                .sort((a, b) => a.used - b.used || Date.parse(a.lastUsedAt ?? a.createdAt) - Date.parse(b.lastUsedAt ?? b.createdAt))
                .slice(0, STICKER_PROMPT_MAX);
            return `[你收藏的图片表情：只有这轮真的合适时才用；不要在他认真难过、生病或讲正事时只发表情。要发就单独输出一行 <sticker:编号>，编号只能从下面选，一轮最多一个，不解释编号]\n`
                + entries.map(entry => `- <sticker:${entry.id}>：${entry.description}${entry.tags.length ? `（${entry.tags.join('、')}）` : ''}`).join('\n');
        },
        clean(reply, allow = true) {
            let kept = false;
            return reply.split('\n').flatMap(line => {
                if (FAKE_STICKER_DESCRIPTION.test(line)) {
                    options.log(`图片表情：去掉模型冒充图片消息的文字「${logBody(line.trim())}」`);
                    return [];
                }
                const hits = [...line.matchAll(TOKEN)];
                if (!hits.length) return [line];
                const exact = EXACT_TOKEN.exec(line.trim());
                const known = exact && index.entries.some(entry => entry.id === exact[1]!.toLowerCase());
                if (allow && known && !kept) {
                    kept = true;
                    return [`<sticker:${exact[1]!.toLowerCase()}>`];
                }
                const plain = line.replace(TOKEN, '').trim();
                options.log(`图片表情：去掉${!allow && known ? '认真照顾轮次里的' : known ? '同一轮多出的' : '未知或混在文字里的'}发送指令「${hits.map(hit => hit[0]).join('、')}」`);
                return plain ? [plain] : [];
            }).join('\n').trim();
        },
        resolve(text) {
            const match = EXACT_TOKEN.exec(text.trim());
            const entry = match ? index.entries.find(item => item.id === match[1]!.toLowerCase()) : undefined;
            return entry ? publicEntry(entry) : undefined;
        },
        history(text) {
            const match = EXACT_TOKEN.exec(text.trim());
            const entry = match ? index.entries.find(item => item.id === match[1]!.toLowerCase()) : undefined;
            return entry ? `${STICKER_HISTORY_PREFIX}${entry.description}` : text;
        },
        used(id) {
            const entry = index.entries.find(item => item.id === id);
            if (!entry) return;
            entry.used++;
            entry.lastUsedAt = now().toISOString();
            persist();
        },
        status: () => ({ count: index.entries.length }),
    };
}

function jsonObject(text: string): Record<string, unknown> {
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) throw new Error('没有 JSON 对象');
    const value = JSON.parse(match[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是 JSON 对象');
    return value as Record<string, unknown>;
}

/**
 * 只把客观图片描述交给收藏判断器，不发送聊天原文或完整角色卡。
 * 这是稳定品味，不让每个联系人把她的收藏偏好改来改去。
 */
export function stickerDecider(llm: AppConfig['llm'], log: (message: string) => void): StickerShelfOptions['decide'] {
    return async (description, summary) => {
        const messages: OpenAIMessage[] = [
            { role: 'system', content: '你替大学女生林梦瑶整理私人 QQ 图片表情收藏。她喜欢可爱、好笑、欠欠的、轻微无语和能自然回朋友的表情；不收藏广告、二维码、政治、色情、猎奇血腥、攻击特定群体、私人照片、只有大段文字或意思看不清的图。真实的政治人物和新闻时政（哪怕配的是玩笑文字、写成反差搞笑）、疫情、战争、宗教、拿枪拿刀指着人或动物、辱骂和脏话、性暗示的图也一律不收；描述里点了真人的名字或头衔，就是真人，不收。只返回 JSON：{"keep":true或false,"description":"不超过30字的客观描述","tags":["1到5个短场景词"]}。不要因为来源于别人就偏爱。' },
            { role: 'user', content: `图片描述：${description}${summary ? `\nQQ 摘要：${summary}` : ''}` },
        ];
        try {
            const extraBody: Record<string, unknown> = { ...llm.extraBody, thinking: { type: 'disabled' } };
            delete extraBody.reasoning_effort;
            const raw = await chatCompletion({
                ...llm, temperature: 0.2, maxTokens: 180,
                extraBody,
            }, messages, { log, purpose: 'background' });
            const value = jsonObject(raw);
            return normalizedDecision({
                keep: value.keep === true,
                description: typeof value.description === 'string' ? value.description : description,
                tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            });
        } catch (error) {
            log(`图片表情：收藏判断失败（${error instanceof Error ? error.message : String(error)}），这张不收`);
            return { keep: false, description, tags: [] };
        }
    };
}
