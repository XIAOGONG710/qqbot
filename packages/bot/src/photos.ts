// 照片货架（ADR 0109，配置 photos，默认关）：她手机里的照片——土豆（楼下的流浪猫）、窗外的天、她拍的片子。
// 来源（用户 10-22：「照片不要用我给她的相册，从网络上找她要发给我的照片，高清」）：她自己从网上找——photo-sources.ts 从 Wikimedia Commons 找 CC0 / 公有领域的高清图，
// 看图模型把关后收进货架（discover）；作者用 photo-cli 手动加也还可以。
// 为什么：他一天里 12% 的消息带图 / 表情，她线上累计 0 张照片；人设里写着“每天下楼喂它，会拍它的照片存手机里，也会拿去给他看”，
// 他说想看土豆时她只能“先不发”。照片不是模型能编的东西：货架里没有照片 = 这个功能什么都不做。
// 范围（第一版）：猫（cat）、风景（view）、她的作品（work，只能手动加）；不含她本人的自拍（那是对她长相的作者裁决，不替作者定）、不含吃的（和她当天吃了什么对不上就穿帮）。
// 用法同表情包：模型要发就单独一行 <photo:编号>；代码清理（未知的 / 混在文字里的 / 一轮多张的都去掉）、解析、发送、聊天记录里写成可读的一句。
// 照片都是“以前拍的”：提示词要求别说成“刚拍的”，免得和她当下在做的事对不上。

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const PHOTO_KINDS = ['cat', 'view', 'work', 'food'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
export const PHOTO_KIND_NAMES: Record<PhotoKind, string> = { cat: '土豆（楼下的流浪猫）', view: '窗外 / 路上的风景', work: '你自己拍的片子', food: '你自己吃的饭' };

export const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
/** 网络来源每一类攒到几张就不再找（猫是同一系列里的，风景换着发） */
export const PHOTO_TARGET: Partial<Record<PhotoKind, number>> = { cat: 8, view: 6 };
/** 每次找，每一类最多下载 / 看几张 */
export const PHOTO_DISCOVERY_PER_RUN = 2;
/** 每隔多久找一次 */
export const PHOTO_DISCOVERY_INTERVAL_MS = 6 * 60 * 60_000;
/** 被限流 / 断网打断后多久再试、最多试几次（Wikimedia 的 Retry-After 有的是 10 分钟） */
export const PHOTO_RETRY_MS = 15 * 60_000;
export const PHOTO_RETRY_MAX = 6;
/** 每道菜攒几张（吃的照片，ADR 0128）：同一道菜轮着发，不用多 */
export const FOOD_PER_DISH = 2;
/** 多久给今天明天的菜找一次照片 */
export const FOOD_DISCOVERY_INTERVAL_MS = 2 * 60 * 60_000;
/** 找一道菜的照片，一轮最多看几张 */
export const FOOD_TRIES_PER_DISH = 4;
/** 一道菜搜不到新的以后多久再搜（毫秒；重启后重新计） */
export const FOOD_MISS_RETRY_MS = 6 * 60 * 60_000;
/** 搜索结果翻页的起点：一页都没有新的就翻下一页 */
const PAGE_OFFSETS = [0, 30, 60] as const;
/** 两次下载之间歇一下：Wikimedia 对快速连续的请求回 429 */
export const PHOTO_DOWNLOAD_GAP_MS = 2000;
/** 这类错误是暂时的（限流、超时、断网）：停这一轮，不把这张标成“看过” */
const TRANSIENT = /\b429\b|\b503\b|timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|aborted/i;
/** 太小的当废图（不是高清） */
const MIN_BYTES = 120 * 1024;
/** 已看过的标题只留最近这么多 */
const SEEN_KEPT = 400;
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
/** 聊天记录里写成这一句（和表情包的 STICKER_HISTORY_PREFIX 一样，下一轮她知道自己发过） */
export const PHOTO_HISTORY_PREFIX = '她发了张照片：';
/** 这么久之内发过就不再发（真人不会一连发好几张同样的） */
export const PHOTO_GAP_MS = 3 * 60 * 60_000;
/** 一天最多几张 */
export const PHOTO_MAX_PER_DAY = 3;
/** 给她看的候选最多几张（同一种里挑，最久没发的在前） */
export const PHOTO_SHORTLIST = 5;

const TOKEN = /<photo:([a-f0-9]{12})>/gi;
const EXACT_TOKEN = /^<photo:([a-f0-9]{12})>$/i;
const INDEX_VERSION = 1;

/** 网络来源的出处（只存给作者看，不进提示词） */
export interface PhotoOrigin {
    title: string;
    page: string;
    license: string;
    artist: string;
    /** 同一系列的 key（同一只猫的几张照片） */
    series: string;
}

/** 搜索到的一个候选 */
export interface PhotoCandidate {
    kind: PhotoKind;
    title: string;
    pageUrl: string;
    /** 要下载的地址（2560 宽的缩略图） */
    imageUrl: string;
    /** 原图的宽高 */
    width: number;
    height: number;
    license: string;
    artist: string;
    series: string;
}

export interface PhotoJudgement {
    keep: boolean;
    /** 一句话说明（只写看得见的东西） */
    caption: string;
    reason?: string;
}

/** 网络来源：搜、下、看；测试里换成假的 */
export interface PhotoSource {
    search(kind: PhotoKind, offset?: number): Promise<PhotoCandidate[]>;
    download(url: string): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>;
    judge(image: { bytes: Uint8Array; type: string }, kind: PhotoKind): Promise<PhotoJudgement>;
}

/** 吃的照片的网络来源（ADR 0128）：按菜名搜，不按种类 */
export interface FoodSource {
    search(dish: string, offset?: number): Promise<PhotoCandidate[]>;
    download(url: string): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>;
    judge(image: { bytes: Uint8Array; type: string }, dish: string): Promise<PhotoJudgement>;
}

export interface PhotoEntry {
    id: string;
    /** 货架目录里的文件名 */
    file: string;
    kind: PhotoKind;
    /** 作者写的一句话：照片里是什么、什么情形（只写事实，不写台词） */
    caption: string;
    addedAt: string;
    used: number;
    lastUsedAt?: string;
    /** 网络来源的出处；手动加的没有 */
    origin?: PhotoOrigin;
    /** 吃的照片是哪道菜（ADR 0128）；只有 food 这一类有 */
    dish?: string;
}

interface PhotoIndex {
    version: typeof INDEX_VERSION;
    entries: PhotoEntry[];
    /** 找过的标题（收了的和被拒的），不再重复下载看 */
    seen: string[];
}

/** 公开给调用方的条目：file 是绝对路径 */
export type PublicPhoto = Omit<PhotoEntry, 'file'> & { file: string };

export interface PhotoShelf {
    /** 作者加一张（CLI 用）：复制进货架、按内容哈希定编号；同一张重复加返回已有的 */
    add(source: string, kind: PhotoKind, caption: string, dish?: string): PhotoEntry;
    remove(id: string): boolean;
    list(kind?: PhotoKind, dish?: string): PhotoEntry[];
    /** 这一类有没有可发的；food 要给菜名（只算这道菜的，没给就是没有） */
    has(kind: PhotoKind, dish?: string): boolean;
    /** 给回复模型看的这一类的候选清单（最久没发的在前）；没有就 undefined。food 要给菜名 */
    prompt(kind: PhotoKind, dish?: string): string | undefined;
    /** 清掉未知的、混在文字里的、同一轮第二张；allow 为 false 时全清掉 */
    clean(reply: string, allow?: boolean): string;
    /** 一整个气泡是不是一张可发送的照片 */
    resolve(text: string): PublicPhoto | undefined;
    /** 真实发出后写入聊天记录的可读内容；普通文字原样返回 */
    history(text: string): string;
    used(id: string): void;
    status(): { count: number; byKind: Record<PhotoKind, number> };
    /** 从网络来源找新的（没配来源就什么都不做）；同一时刻只跑一个。返回 retry = 这一轮被限流 / 断网打断了，调用方过一会儿再来 */
    discover(): Promise<'done' | 'retry'>;
    /** 给这几道菜各找照片（ADR 0128，没配 foodSource 就什么都不做）；已经有够的、刚搜过没有的跳过。返回 retry 同 discover */
    discoverFood(dishes: readonly string[]): Promise<'done' | 'retry'>;
}

export interface PhotoShelfOptions {
    dir: string;
    log: (message: string) => void;
    now?: () => Date;
    /** 网络来源（photo-sources.ts + 下载 + 看图）；不给就只有作者手动加的 */
    source?: PhotoSource;
    /** 吃的照片的来源（ADR 0128，photo-sources.ts 的 webFoodSource）；不给就没有吃的照片 */
    foodSource?: FoodSource;
    /** 两次下载之间歇多久（毫秒，默认 PHOTO_DOWNLOAD_GAP_MS；Wikimedia 限流，测试里给 0） */
    pauseMs?: number;
}

const emptyIndex = (): PhotoIndex => ({ version: INDEX_VERSION, entries: [], seen: [] });

function readIndex(file: string, log: (message: string) => void): PhotoIndex {
    if (!existsSync(file)) return emptyIndex();
    try {
        const value = JSON.parse(readFileSync(file, 'utf8')) as PhotoIndex;
        if (value?.version !== INDEX_VERSION || !Array.isArray(value.entries)) throw new Error('版本或结构不对');
        const entries = value.entries.filter(entry => typeof entry?.id === 'string' && /^[a-f0-9]{12}$/.test(entry.id)
            && typeof entry.file === 'string' && PHOTO_KINDS.includes(entry.kind) && typeof entry.caption === 'string' && entry.caption.trim()
            && typeof entry.used === 'number' && (entry.dish === undefined || typeof entry.dish === 'string'));
        if (entries.length !== value.entries.length) log(`照片货架：${value.entries.length - entries.length} 条记录不合格，已忽略`);
        const seen = Array.isArray(value.seen) ? value.seen.filter((title): title is string => typeof title === 'string') : [];
        return { version: INDEX_VERSION, entries, seen };
    } catch (error) {
        log(`照片货架：索引读不了（${error instanceof Error ? error.message : String(error)}），当作空的；原文件不动`);
        return emptyIndex();
    }
}

export function photoShelf(options: PhotoShelfOptions): PhotoShelf {
    const now = options.now ?? (() => new Date());
    const filesDir = join(options.dir, 'files');
    const indexFile = join(options.dir, 'index.json');
    let index = readIndex(indexFile, options.log);

    const persist = () => {
        mkdirSync(options.dir, { recursive: true });
        const tmp = `${indexFile}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
        renameSync(tmp, indexFile);
    };
    // food 一类只算同一道菜的：没给菜名就是没有（不会拿别的菜的照片说是这一顿）
    const present = (kind?: PhotoKind, dish?: string) => index.entries.filter(entry => (!kind || entry.kind === kind) && (kind !== 'food' || (dish !== undefined && entry.dish === dish)) && existsSync(join(filesDir, entry.file)));
    const publicOf = (entry: PhotoEntry): PublicPhoto => ({ ...entry, file: join(filesDir, entry.file) });
    const byId = (id: string) => index.entries.find(entry => entry.id === id.toLowerCase() && existsSync(join(filesDir, entry.file)));

    let discovering = false;
    let discoveringFood = false;
    const foodMissAt = new Map<string, number>();
    const extFor = (type: string) => (type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : type === 'image/gif' ? '.gif' : '.jpg');
    const markSeen = (title: string) => {
        index = { ...index, seen: [...index.seen.filter(t => t !== title), title].slice(-SEEN_KEPT) };
        persist();
    };

    return {
        async discover() {
            const source = options.source;
            if (!source || discovering) return 'done';
            discovering = true;
            let outcome: 'done' | 'retry' = 'done';
            let downloaded = 0;
            try {
                for (const kind of PHOTO_KINDS) {
                    const target = PHOTO_TARGET[kind];
                    if (!target || present(kind).length >= target) continue;
                    const seen = new Set(index.seen);
                    const owned = new Set(index.entries.map(entry => entry.origin?.title).filter((t): t is string => Boolean(t)));
                    let fresh: PhotoCandidate[] = [];
                    for (const offset of PAGE_OFFSETS) {
                        let found: PhotoCandidate[];
                        try { found = await source.search(kind, offset); } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            options.log(`照片货架：找${kind}失败（${reason}），下次再试`);
                            if (TRANSIENT.test(reason)) outcome = 'retry';
                            break;
                        }
                        fresh = found.filter(c => c.kind === kind && !seen.has(c.title) && !owned.has(c.title));
                        if (fresh.length) break;
                    }
                    if (!fresh.length) continue;
                    // 猫：同一只（同一系列）的照片放一起——已经有的系列优先；还没有就取候选最多的那个系列
                    if (kind === 'cat') {
                        const have = new Set(present('cat').map(entry => entry.origin?.series).filter((t): t is string => Boolean(t)));
                        const groups = new Map<string, PhotoCandidate[]>();
                        for (const c of fresh) groups.set(c.series, [...(groups.get(c.series) ?? []), c]);
                        // 已经有了一只猫的照片，就只收同一系列的——土豆只有一只；那个系列收完了就停，不换另一只猫
                        const preferred = have.size
                            ? [...groups.entries()].filter(([key]) => have.has(key)).sort((a, b) => b[1].length - a[1].length)[0]
                            : [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
                        fresh = preferred ? preferred[1] : [];
                        if (!fresh.length) continue;
                    }
                    let tried = 0;
                    for (const candidate of fresh) {
                        if (tried >= PHOTO_DISCOVERY_PER_RUN) break;
                        if (tried > 0 || downloaded > 0) await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? PHOTO_DOWNLOAD_GAP_MS));
                        tried++;
                        downloaded++;
                        try {
                            const image = await source.download(candidate.imageUrl);
                            if (image.bytes.length < MIN_BYTES) { markSeen(candidate.title); options.log(`照片货架：${candidate.title} 文件太小（${Math.round(image.bytes.length / 1024)} KB），不收`); continue; }
                            if (image.bytes.length > PHOTO_MAX_BYTES) { markSeen(candidate.title); options.log(`照片货架：${candidate.title} 太大，不收`); continue; }
                            const judged = await source.judge(image, kind);
                            markSeen(candidate.title);
                            if (!judged.keep) { options.log(`照片货架：不收 ${candidate.title}（${judged.reason ?? '没通过'}）`); continue; }
                            const id = createHash('sha256').update(image.bytes).digest('hex').slice(0, 12);
                            if (index.entries.some(entry => entry.id === id)) continue;
                            mkdirSync(filesDir, { recursive: true });
                            const file = `${id}${extFor(image.type)}`;
                            writeFileSync(join(filesDir, file), image.bytes);
                            const entry: PhotoEntry = {
                                id, file, kind, caption: judged.caption, addedAt: now().toISOString(), used: 0,
                                origin: { title: candidate.title, page: candidate.pageUrl, license: candidate.license, artist: candidate.artist, series: candidate.series },
                            };
                            index = { ...index, entries: [...index.entries, entry] };
                            persist();
                            options.log(`照片货架：收了一张 ${kind}（${id}；${candidate.width}×${candidate.height}，${candidate.license}；${candidate.title}）`);
                        } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            if (TRANSIENT.test(reason)) {
                                options.log(`照片货架：处理 ${candidate.title} 时遇到暂时的错误（${reason}），这一轮先停，下次再来`);
                                return 'retry';
                            }
                            markSeen(candidate.title);
                            options.log(`照片货架：处理 ${candidate.title} 失败（${reason}），以后不再试这张`);
                        }
                    }
                }
                return outcome;
            } finally {
                discovering = false;
            }
        },
        async discoverFood(dishes) {
            const source = options.foodSource;
            if (!source || discoveringFood) return 'done';
            discoveringFood = true;
            let outcome: 'done' | 'retry' = 'done';
            let downloaded = 0;
            try {
                for (const dish of [...new Set(dishes)]) {
                    if (present('food', dish).length >= FOOD_PER_DISH) continue;
                    const missedAt = foodMissAt.get(dish);
                    if (missedAt !== undefined && now().getTime() - missedAt < FOOD_MISS_RETRY_MS) continue;
                    const seen = new Set(index.seen);
                    const owned = new Set(index.entries.map(entry => entry.origin?.title).filter((t): t is string => Boolean(t)));
                    const seenKey = (title: string) => `${dish}|${title}`;
                    let fresh: PhotoCandidate[] = [];
                    for (const offset of PAGE_OFFSETS) {
                        let found: PhotoCandidate[];
                        try { found = await source.search(dish, offset); } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            options.log(`照片货架：找「${dish}」的照片失败（${reason}），下次再试`);
                            if (TRANSIENT.test(reason)) outcome = 'retry';
                            break;
                        }
                        fresh = found.filter(c => !seen.has(seenKey(c.title)) && !owned.has(c.title));
                        if (fresh.length) break;
                        if (!found.length) break;
                    }
                    if (!fresh.length) { if (outcome !== 'retry') foodMissAt.set(dish, now().getTime()); continue; }
                    let tried = 0;
                    for (const candidate of fresh) {
                        if (tried >= FOOD_TRIES_PER_DISH || present('food', dish).length >= FOOD_PER_DISH) break;
                        if (downloaded > 0) await new Promise(resolve => setTimeout(resolve, options.pauseMs ?? PHOTO_DOWNLOAD_GAP_MS));
                        tried++;
                        downloaded++;
                        try {
                            const image = await source.download(candidate.imageUrl);
                            if (image.bytes.length < MIN_BYTES / 2) { markSeen(seenKey(candidate.title)); options.log(`照片货架：${candidate.title} 文件太小，不收`); continue; }
                            if (image.bytes.length > PHOTO_MAX_BYTES) { markSeen(seenKey(candidate.title)); options.log(`照片货架：${candidate.title} 太大，不收`); continue; }
                            const judged = await source.judge(image, dish);
                            markSeen(seenKey(candidate.title));
                            if (!judged.keep) { options.log(`照片货架：不收 ${candidate.title}（${dish}：${judged.reason ?? '没通过'}）`); continue; }
                            const id = createHash('sha256').update(image.bytes).digest('hex').slice(0, 12);
                            if (index.entries.some(entry => entry.id === id)) continue;
                            mkdirSync(filesDir, { recursive: true });
                            const file = `${id}${extFor(image.type)}`;
                            writeFileSync(join(filesDir, file), image.bytes);
                            const entry: PhotoEntry = {
                                id, file, kind: 'food', dish, caption: judged.caption, addedAt: now().toISOString(), used: 0,
                                origin: { title: candidate.title, page: candidate.pageUrl, license: candidate.license, artist: candidate.artist, series: dish },
                            };
                            index = { ...index, entries: [...index.entries, entry] };
                            persist();
                            options.log(`照片货架：收了一张「${dish}」（${id}；${candidate.width}×${candidate.height}，${candidate.license}；${candidate.title}）`);
                        } catch (error) {
                            const reason = error instanceof Error ? error.message : String(error);
                            if (TRANSIENT.test(reason)) {
                                options.log(`照片货架：处理 ${candidate.title} 时遇到暂时的错误（${reason}），这一轮先停，下次再来`);
                                return 'retry';
                            }
                            markSeen(seenKey(candidate.title));
                            options.log(`照片货架：处理 ${candidate.title} 失败（${reason}），以后不再试这张`);
                        }
                    }
                }
                return outcome;
            } finally {
                discoveringFood = false;
            }
        },
        add(source, kind, caption, dish) {
            if (!PHOTO_KINDS.includes(kind)) throw new Error(`种类只能是 ${PHOTO_KINDS.join(' / ')}`);
            const text = caption.trim();
            if (!text) throw new Error('要写一句照片里是什么');
            const extension = extname(source).toLowerCase();
            if (!ALLOWED_EXT.has(extension)) throw new Error(`只收 ${[...ALLOWED_EXT].join(' / ')}`);
            const size = statSync(source).size;
            if (size > PHOTO_MAX_BYTES) throw new Error(`文件太大（${Math.round(size / 1024 / 1024)} MB，上限 ${PHOTO_MAX_BYTES / 1024 / 1024} MB）`);
            const id = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 12);
            const existing = index.entries.find(entry => entry.id === id);
            if (existing) return existing;
            mkdirSync(filesDir, { recursive: true });
            const file = `${id}${extension === '.jpeg' ? '.jpg' : extension}`;
            copyFileSync(source, join(filesDir, file));
            const entry: PhotoEntry = { id, file, kind, caption: text, addedAt: now().toISOString(), used: 0, ...(kind === 'food' && dish ? { dish } : {}) };
            index = { ...index, entries: [...index.entries, entry] };
            persist();
            options.log(`照片货架：加了一张 ${kind}（${id}；来自 ${basename(source)}）`);
            return entry;
        },
        remove(id) {
            const before = index.entries.length;
            index = { ...index, entries: index.entries.filter(entry => entry.id !== id.toLowerCase()) };
            if (index.entries.length === before) return false;
            persist();
            return true;
        },
        list: (kind, dish) => present(kind, dish),
        has: (kind, dish) => present(kind, dish).length > 0,
        prompt(kind, dish) {
            const list = present(kind, dish)
                .sort((a, b) => a.used - b.used || Date.parse(a.lastUsedAt ?? a.addedAt) - Date.parse(b.lastUsedAt ?? b.addedAt))
                .slice(0, PHOTO_SHORTLIST);
            if (!list.length) return undefined;
            // 吃的照片是这一顿饭拍的（ADR 0128），可以说“刚拍的”；别的照片都是以前拍的
            const when = kind === 'food' ? `这一顿${dish ? `（${dish}）` : ''}你拍的照片，可以说是吃饭时拍的` : '都是以前拍的，别说成刚拍的';
            return `[你手机里${PHOTO_KIND_NAMES[kind]}的照片（${when}；只能从下面选，编号不解释，一轮最多发一张）：发就另起一行单独写 <photo:编号>，这一行必须有，别的字不要塞在这一行里]\n`
                + list.map(entry => `- <photo:${entry.id}>：${entry.caption}`).join('\n');
        },
        clean(reply, allow = true) {
            let kept = false;
            return reply.split('\n').flatMap(line => {
                const hits = [...line.matchAll(TOKEN)];
                if (!hits.length) return [line];
                const exact = EXACT_TOKEN.exec(line.trim());
                const known = exact && byId(exact[1]!);
                if (allow && known && !kept) {
                    kept = true;
                    return [`<photo:${exact![1]!.toLowerCase()}>`];
                }
                const plain = line.replace(TOKEN, '').trim();
                options.log(`照片货架：去掉${!allow && known ? '这一轮不该发的' : known ? '同一轮多出的' : '未知或混在文字里的'}发送指令「${hits.map(hit => hit[0]).join('、')}」`);
                return plain ? [plain] : [];
            }).join('\n').trim();
        },
        resolve(text) {
            const match = EXACT_TOKEN.exec(text.trim());
            const entry = match ? byId(match[1]!) : undefined;
            return entry ? publicOf(entry) : undefined;
        },
        history(text) {
            const match = EXACT_TOKEN.exec(text.trim());
            const entry = match ? byId(match[1]!) : undefined;
            return entry ? `${PHOTO_HISTORY_PREFIX}${entry.caption}` : text;
        },
        used(id) {
            const entry = index.entries.find(item => item.id === id.toLowerCase());
            if (!entry) return;
            entry.used++;
            entry.lastUsedAt = now().toISOString();
            persist();
        },
        status() {
            const byKind = { cat: 0, view: 0, work: 0, food: 0 } as Record<PhotoKind, number>;
            for (const entry of present()) byKind[entry.kind]++;
            return { count: present().length, byKind };
        },
    };
}

// ───────── 什么时候发（代码定，不靠模型自觉）─────────

/**
 * 他在要看哪一类的照片：必须同时有“要看 / 发 / 拍”的意思和明确的对象；只说“想看你”“发张自拍”（本人）不算——自拍不在货架里，照旧走“先不发”。
 * 没有明确对象（只说“发张照片看看”）：猫 > 风景 > 作品，取手上有的第一类由调用方决定，这里返回 'any'
 */
const SHOW_WORDS = /看看|瞧瞧|康康|看下|看一下|发(?:来|过来|给我|我|一?张|个)|拍(?:一?张|给我|来看)|有(?:图|照片)吗|照片呢|图呢|晒|给我看/;
const CAT_WORDS = /土豆|猫|喵|三花/;
const VIEW_WORDS = /风景|天空|夕阳|落日|晚霞|窗外|云|月亮|下雪|雪景|雨景|路上/;
const WORK_WORDS = /你拍的|你修的|作品|片子|相机里|拍的照片|修的图|摄影/;
/** 要看吃的（ADR 0128）：吃的 / 饭 / 菜 / 外卖 / 食堂 / 具体的一餐；比“你拍的”优先（「拍给我看看你吃的」） */
const FOOD_WORDS = /吃的|吃了啥|吃什么|午饭|晚饭|这顿|那顿|饭菜|外卖|食堂|饭呢|你的饭|吃啥/;
const SELF_WORDS = /自拍|你的脸|你长啥|你长什么|看看你|想看你|看你本人|穿.{0,4}给我看|你现在的样子|你在干嘛的照片/;
/** 明确要她本人（脸、自拍、样子）的说法：带吃的字眼也不放行 */
const HARD_SELF_WORDS = /自拍|你的脸|你长啥|你长什么|看你本人|穿.{0,4}给我看|你现在的样子|你在干嘛的照片/;
export function photoWanted(text: string): PhotoKind | 'any' | undefined {
    if (!SHOW_WORDS.test(text)) return undefined;
    // 「看看你吃的」是要看饭，不是要看她本人（ADR 0128）：有吃的字眼、又没有明确要她的脸 / 自拍时放行
    if (SELF_WORDS.test(text) && !(FOOD_WORDS.test(text) && !HARD_SELF_WORDS.test(text))) return undefined;
    if (CAT_WORDS.test(text)) return 'cat';
    if (VIEW_WORDS.test(text)) return 'view';
    if (FOOD_WORDS.test(text)) return 'food';
    if (WORK_WORDS.test(text)) return 'work';
    return /照片|图|相片/.test(text) ? 'any' : undefined;
}

/** 这一轮能不能发照片：危机 / 被吵醒 / 最近发过 / 今天发够了就不发。history 是聊天记录（含她发过的“她发了张照片：”） */
export function photoAllowance(
    history: readonly { role: 'user' | 'assistant'; content: string; time?: string }[],
    now: number,
    crisis = false,
    woken = false,
): { allowed: boolean; reason?: string } {
    if (crisis) return { allowed: false, reason: '危机辅助响应' };
    if (woken) return { allowed: false, reason: '刚被消息吵醒' };
    const sent = history.filter((message): message is typeof message & { time: string } => message.role === 'assistant' && message.content.startsWith(PHOTO_HISTORY_PREFIX) && message.time !== undefined);
    const last = sent.at(-1);
    if (last && now - Date.parse(last.time) < PHOTO_GAP_MS) return { allowed: false, reason: '刚发过一张' };
    const today = new Date(now);
    const sameDay = (time: string) => { const d = new Date(time); return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate(); };
    if (sent.filter(message => sameDay(message.time)).length >= PHOTO_MAX_PER_DAY) return { allowed: false, reason: '今天发够了' };
    return { allowed: true };
}

/** 这一轮的意图行：他要看的照片她有，就发；先带一句，再另起一行放照片 */
export function photoIntent(kind: PhotoKind): string {
    if (kind === 'food') return '[这一轮你想：他想看你吃的饭，你吃饭时刚好拍了：先用一句话带一下（说是哪一顿、吃的什么，看「你那边」吃的那一行，没写的细节不编），然后另起一行单独发照片；不用解释，别多说]';
    return `[这一轮你想：他想看${PHOTO_KIND_NAMES[kind]}的照片，你手机里正好有，翻出来发给他：先用一句话带一下（像随手翻出来的，是以前拍的，别说成刚拍的、别说“现在拍”），然后另起一行单独发照片；不用解释照片怎么来的，别多说]`;
}
