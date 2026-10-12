// 图片表情收藏（ADR 0063）：
// - 候选来自 QQ 自定义表情、公开目录、微信/网页导入箱，以及名单联系人发来的图片表情；
// - 先看图、按林梦瑶稳定的偏好判断要不要留，再下载到 dataDir/stickers；
// - 回复模型只能从提示词列出的稳定编号里选，输出单独一行 <sticker:编号>，未知或混在文字里的指令不会发送；
// - 收藏任务后台串行，不挡住正常收消息和回复。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import type { AppConfig } from './config.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { chatCompletion } from './llm.ts';
import { isSticker, type ImageDescriber } from './media.ts';
import type { Segment } from './onebot.ts';
import type { OpenAIMessage } from './prompt.ts';

export const STICKER_MAX_BYTES = 5 * 1024 * 1024;
export const STICKER_PROMPT_MAX = 12;
export const STICKER_DISCOVERY_PER_RUN = 3;
export const STICKER_DISCOVERY_PER_DAY = 3;
export const STICKER_DISCOVERY_INTERVAL_MS = 60 * 60_000;
export const STICKER_NETWORK_PACE_MS = 2_000;
export const STICKER_USER_AGENT = 'qqbot-image-stickers/1.0 (+https://github.com/XIAOGONG710/qqbot)';
export const STICKER_LIBRARY_MAX = 80;
export const STICKER_REPLY_WINDOW = 8;
export const STICKER_HISTORY_PREFIX = '她发了个表情包：';
const INDEX_VERSION = 1;
const TOKEN_LIKE = /<sticker:[^>\r\n]*(?:>|$)/gi;
const EXACT_TOKEN = /^<sticker:([a-f0-9]{12})>$/i;
/** 模型不能用文字冒充真的图片消息；真实发送后的历史才会写入可读描述。 */
const FAKE_STICKER_DESCRIPTION = /^\s*(?:(?:她|我)?发了?(?:一?个)?表情包[：:].+|[\[【（(]表情包[^\]】）)]*[\]】）)])\s*$/;
const dispatcher = new Agent({ connect: { timeout: 3000 } });

/** 没有发送权限的档位也不能把内部编号或文字占位符直接发给对方。 */
export function stripStickerArtifacts(reply: string): string {
    return reply.split('\n').flatMap(line => {
        if (FAKE_STICKER_DESCRIPTION.test(line)) return [];
        const plain = line.replace(TOKEN_LIKE, '').trim();
        return plain ? [plain] : [];
    }).join('\n').trim();
}

/** 图片表情是调味，不在需要认真回应、刚被吵醒或最近已经用过时出现。 */
export function imageStickerAllowance(
    history: readonly Pick<StoredMessage, 'role' | 'content'>[],
    intent?: string,
    woken = false,
): { allowed: boolean; reason?: string } {
    if (woken) return { allowed: false, reason: '刚被消息吵醒' };
    const recentReplies = history.filter(message => message.role === 'assistant').slice(-STICKER_REPLY_WINDOW);
    if (recentReplies.some(message => message.content.startsWith(STICKER_HISTORY_PREFIX))) {
        return { allowed: false, reason: `最近 ${STICKER_REPLY_WINDOW} 条回复里已经发过图片表情` };
    }
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const current = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (/[？?]|(?:^|[，。！!\s])(?:怎么|为什么|咋|多少|几点|哪里|哪儿|谁|什么|是不是|有没有)/.test(current)
        || /(?:吗|嘛|呢)[？?。！!\s]*$/.test(current)) {
        return { allowed: false, reason: '他这一轮问了直接问题' };
    }
    if (intent && /他想看照片|先接住他此刻的情绪|回应他刚说的那件事|他刚说了件好事|先直接回答他刚问的/.test(intent)) {
        return { allowed: false, reason: '这一轮要认真回应他说的事' };
    }
    if (/(?:面试|考试|答辩|作业|工作|老板|老师|导师|家里|医院|生病|受伤|事故|出事|分手|吵架|转账|欠钱|难过|伤心|焦虑|害怕|疼|痛|累死|烦死)/.test(current)) {
        return { allowed: false, reason: '他在认真说事' };
    }
    return { allowed: true };
}

export interface StickerSource {
    kind: 'received' | 'qq-custom' | 'inbox' | 'web' | 'bqb';
    from?: number;
    messageId?: number;
    name?: string;
    category?: string;
}

export interface StickerCandidate {
    url: string;
    category?: string;
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
    /** 人工看过实际图片并确认描述可用；collect 阶段的上线证据。 */
    reviewedAt?: string;
}

export type StickerReviewEntry = Omit<StickerEntry, 'file'>;
export interface StickerShelfStatus {
    count: number;
    discovery?: { day: string; reviewed: number; limit: number };
}

interface StickerIndex {
    version: typeof INDEX_VERSION;
    entries: StickerEntry[];
    /** 已看过的 URL（无论收没收藏）。只留最近一批，避免每次重启重新付一次看图费用，也能继续往表情池后面翻。 */
    seen: string[];
    /** 定时发现的按日本地预算；收到别人发来的表情不占这个预算。 */
    discovery?: { day: string; reviewed: number };
}

export interface StickerDecision {
    keep: boolean;
    description: string;
    tags: string[];
}

export interface DownloadedSticker {
    bytes: Uint8Array;
    type: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface StickerShelfOptions {
    dir: string;
    describe: ImageDescriber['describe'];
    decide: (description: string, summary?: string) => Promise<StickerDecision>;
    download?: (url: string) => Promise<DownloadedSticker>;
    /** 持续更新的公开网络候选源；与导入箱、QQ 自定义表情共用每日预算。 */
    trendDiscover?: () => Promise<readonly (string | StickerCandidate)[]>;
    /** QQ 账号已有的自定义表情。 */
    discover?: () => Promise<string[]>;
    log: (message: string) => void;
    now?: () => Date;
    discoveryPerRun?: number;
    discoveryPerDay?: number;
    discoveryIntervalMs?: number;
    networkPaceMs?: number;
    sleep?: (ms: number) => Promise<void>;
    libraryMax?: number;
}

export interface StickerShelf {
    /** 从一条收到的 OneBot 消息里挑图片表情；后台调用方不用等。 */
    consider(message: Segment[] | string, source: Omit<StickerSource, 'kind'>): Promise<void>;
    /** 每小时在空闲时触发；从导入箱、公开网络候选源和 QQ 自定义表情池使用持久化的每日预算。 */
    discover(): Promise<void>;
    /** 给回复模型看的本地收藏清单。 */
    prompt(): string | undefined;
    /** 清掉未知、混在文字里的、以及同一轮第二个图片表情指令。 */
    clean(reply: string, allow?: boolean): string;
    /** 一整个气泡是不是一个可发送的收藏表情。 */
    resolve(text: string): StickerEntry | undefined;
    /** 真实图片发出后写入聊天记录的可读内容；普通文字原样返回。 */
    history(text: string): string;
    used(id: string): void;
    status(): StickerShelfStatus;
    /** 控制台人工核对用；不暴露本地路径。 */
    review?(): StickerReviewEntry[];
    /** 控制台按稳定编号一次读取一张图，避免把整库塞进定时状态推送。 */
    preview?(id: string): string | undefined;
    /** 控制台人工核对标记；取消标记不会删除收藏。 */
    setReviewed?(id: string, reviewed: boolean): boolean;
}

const emptyIndex = (): StickerIndex => ({ version: INDEX_VERSION, entries: [], seen: [] });

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** 图片 URL 可能带短期 rkey；只把它作为本次去重线索，不写进提示词和聊天记录。 */
function sourceKey(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

function typeOf(bytes: Uint8Array, header?: string): DownloadedSticker['type'] | undefined {
    const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    const type = header?.split(';')[0]?.trim().toLowerCase();
    return type === 'image/png' || type === 'image/gif' || type === 'image/jpeg' || type === 'image/webp' ? type : undefined;
}

export async function downloadSticker(url: string): Promise<DownloadedSticker> {
    if (!/^https?:\/\//i.test(url)) throw new Error('只接受 http/https 图片地址');
    const response = await undiciFetch(url, {
        dispatcher,
        headers: { 'user-agent': STICKER_USER_AGENT },
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`下载返回 ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > STICKER_MAX_BYTES) throw new Error(`图片超过 ${STICKER_MAX_BYTES} 字节`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > STICKER_MAX_BYTES) throw new Error('图片为空或太大');
    const type = typeOf(bytes, response.headers.get('content-type') ?? undefined);
    if (!type) throw new Error('不是支持的 PNG/JPEG/GIF/WebP 图片');
    return { bytes, type };
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
    if (index.discovery && (typeof index.discovery.day !== 'string' || !Number.isFinite(index.discovery.reviewed))) delete index.discovery;
    const now = options.now ?? (() => new Date());
    const download = options.download ?? downloadSticker;
    const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const pending = new Set<string>();
    let queue = Promise.resolve();
    let lastDiscoveredAt: number | undefined;
    let lastPublicCandidateAt: number | undefined;
    const libraryMax = options.libraryMax ?? STICKER_LIBRARY_MAX;
    const discoveryPerDay = options.discoveryPerDay ?? STICKER_DISCOVERY_PER_DAY;
    const networkPaceMs = options.networkPaceMs ?? STICKER_NETWORK_PACE_MS;

    const persist = () => writeJsonAtomic(indexPath, index);
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
    const pacePublicCandidate = async () => {
        const at = Date.now();
        const wait = lastPublicCandidateAt === undefined ? 0 : networkPaceMs - (at - lastPublicCandidateAt);
        if (wait > 0) await sleep(wait);
        lastPublicCandidateAt = Date.now();
    };

    async function considerOne(url: string, summary: string | undefined, source: StickerSource): Promise<void> {
        const key = sourceKey(url);
        const description = (await options.describe({ url })).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!description) return reject(key, '看不清内容');
        const decision = normalizedDecision(await options.decide(description, summary));
        if (!decision.keep) return reject(key, `不收（${decision.description || description}）`);
        const image = await download(url);
        keep(key, image, decision, source);
    }

    async function considerInbox(path: string): Promise<void> {
        const key = inboxKey(path);
        if (pending.has(key) || index.seen.includes(key)) return;
        pending.add(key);
        try {
            const bytes = new Uint8Array(readFileSync(path));
            if (!bytes.length || bytes.length > STICKER_MAX_BYTES) return reject(key, `${basename(path)} 为空或超过 5 MB`);
            const type = typeOf(bytes);
            if (!type) return reject(key, `${basename(path)} 不是支持的 PNG/JPEG/GIF/WebP`);
            const dataUrl = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
            const description = (await options.describe({ url: dataUrl, file: path })).replace(/\s+/g, ' ').trim().slice(0, 120);
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
        index.entries.push({
            id, file: name, description: decision.description, tags: decision.tags, source,
            createdAt: now().toISOString(), used: 0,
        });
        markSeen(key);
        persist();
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
            const discoveredAt = now();
            const at = discoveredAt.getTime();
            const interval = options.discoveryIntervalMs ?? STICKER_DISCOVERY_INTERVAL_MS;
            if (lastDiscoveredAt !== undefined && at - lastDiscoveredAt < interval) return;
            lastDiscoveredAt = at;
            const day = localDay(discoveredAt);
            const reviewed = index.discovery?.day === day ? Math.max(0, Math.floor(index.discovery.reviewed)) : 0;
            let remaining = Math.min(options.discoveryPerRun ?? STICKER_DISCOVERY_PER_RUN, Math.max(0, discoveryPerDay - reviewed));
            const reserve = () => {
                if (remaining <= 0) return false;
                const current = index.discovery?.day === day ? Math.max(0, Math.floor(index.discovery.reviewed)) : 0;
                index.discovery = { day, reviewed: current + 1 };
                remaining--;
                persist();
                return true;
            };
            if (remaining <= 0) return;

            const local = inboxFiles(inboxDir).filter(path => {
                try { return !index.seen.includes(inboxKey(path)); } catch { return false; }
            }).sort();
            for (const path of local.slice(0, remaining)) {
                if (!reserve()) break;
                const task = queue.then(() => considerInbox(path))
                    .catch(error => options.log(`图片表情：导入 ${basename(path)} 失败（${error instanceof Error ? error.message : String(error)}）`));
                queue = task;
                await task;
            }

            const manifest = join(inboxDir, 'urls.txt');
            const webUrls = existsSync(manifest)
                ? readFileSync(manifest, 'utf8').split(/\r?\n/).map(line => line.trim())
                    .filter(line => line && !line.startsWith('#') && /^https?:\/\//i.test(line))
                : [];
            for (const url of [...new Set(webUrls)].filter(url => !index.seen.includes(sourceKey(url))).slice(0, remaining)) {
                if (!reserve()) break;
                const name = (() => { try { return new URL(url).hostname; } catch { return 'urls.txt'; } })();
                await pacePublicCandidate();
                await enqueue(url, undefined, { kind: 'web', name });
            }

            if (remaining > 0 && options.trendDiscover) {
                const candidates = (await options.trendDiscover()).map(candidate => typeof candidate === 'string' ? { url: candidate } : candidate);
                const fresh = candidates.filter((candidate, position) => /^https?:\/\//i.test(candidate.url)
                    && candidates.findIndex(other => other.url === candidate.url) === position
                    && !index.seen.includes(sourceKey(candidate.url)));
                for (const candidate of fresh.slice(0, remaining)) {
                    if (!reserve()) break;
                    await pacePublicCandidate();
                    await enqueue(candidate.url, undefined, {
                        kind: 'bqb', name: 'ChineseBQB',
                        ...(candidate.category ? { category: candidate.category.replace(/\s+/g, ' ').trim().slice(0, 40) } : {}),
                    });
                }
            }

            if (remaining > 0 && options.discover) {
                const urls = await options.discover();
                const fresh = [...new Set(urls)].filter(url => typeof url === 'string' && /^https?:\/\//i.test(url) && !index.seen.includes(sourceKey(url)));
                for (const url of fresh.slice(0, remaining)) {
                    if (!reserve()) break;
                    await enqueue(url, undefined, { kind: 'qq-custom' });
                }
            }
        },
        prompt() {
            if (!index.entries.length) return undefined;
            const entries = index.entries.filter(entry => existsSync(join(options.dir, entry.file)))
                .sort((a, b) => a.used - b.used || Date.parse(a.lastUsedAt ?? a.createdAt) - Date.parse(b.lastUsedAt ?? b.createdAt))
                .slice(0, STICKER_PROMPT_MAX);
            return `[你收藏的图片表情：只有这轮真的合适时才用；不要在他认真难过、生病或讲正事时只发表情。要发就单独输出一行 <sticker:编号>，编号只能从下面选，一轮最多一个，不解释编号]\n`
                + entries.map(entry => `- <sticker:${entry.id}>：${entry.description}${entry.tags.length ? `（${entry.tags.join('、')}）` : ''}`).join('\n');
        },
        clean(reply, allow = true) {
            let kept = false;
            return reply.split('\n').flatMap(line => {
                if (FAKE_STICKER_DESCRIPTION.test(line)) {
                    options.log(`图片表情：去掉模型冒充图片消息的文字「${line.trim()}」`);
                    return [];
                }
                const hits = [...line.matchAll(TOKEN_LIKE)];
                if (!hits.length) return [line];
                const exact = EXACT_TOKEN.exec(line.trim());
                const known = exact && index.entries.some(entry => entry.id === exact[1]!.toLowerCase());
                if (allow && known && !kept) {
                    kept = true;
                    return [`<sticker:${exact[1]!.toLowerCase()}>`];
                }
                const plain = line.replace(TOKEN_LIKE, '').trim();
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
        status: () => {
            const day = localDay(now());
            return {
                count: index.entries.length,
                discovery: {
                    day,
                    reviewed: index.discovery?.day === day ? Math.max(0, Math.floor(index.discovery.reviewed)) : 0,
                    limit: discoveryPerDay,
                },
            };
        },
        review: () => index.entries.map(({ file: _file, ...entry }) => structuredClone(entry)),
        preview(id) {
            const entry = /^[a-f0-9]{12}$/.test(id) ? index.entries.find(item => item.id === id) : undefined;
            if (!entry) return undefined;
            const path = join(options.dir, entry.file);
            if (!existsSync(path)) return undefined;
            const bytes = new Uint8Array(readFileSync(path));
            const type = typeOf(bytes);
            return type ? `data:${type};base64,${Buffer.from(bytes).toString('base64')}` : undefined;
        },
        setReviewed(id, reviewed) {
            const entry = /^[a-f0-9]{12}$/.test(id) ? index.entries.find(item => item.id === id) : undefined;
            if (!entry) return false;
            if (reviewed) entry.reviewedAt = now().toISOString();
            else delete entry.reviewedAt;
            persist();
            return true;
        },
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
            }, messages, { log });
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
