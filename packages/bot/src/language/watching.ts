// 她自己在 B 站看东西、形成看法（ADR 0130，配置 watching，默认关；要 bilibiliAccount 开着）。
// 用户 10-23：「能否让她在 bilibili 学习像人一样说话和思考」。
// 先取证（10-23 实测）：
//   - “说话”：B 站评论区不适合当语料。热门视频评论区 957 句候选，用「像不像真人」的尺子（humanness）筛到 270 句，再让模型判“像熟人私下聊天会说的话”只剩 39 句（4%），
//     而且全是「哈哈哈哈哈」「是的！」「支持继续扒！」「加油」这类依赖视频内容的话——比她现在写的还空。不做语料库；新词新梗那部分已经由 ADR 0129 的 memes 管了。
//   - “思考”：人有看法，是因为看过、经历过，而且记得。她缺的是“真看过什么”：现在的刷 B 站只是挑一个视频发给他（一周 3 个），看完没有任何留下来的东西。
// 做法（派生数据，不碰角色卡）：
//   1. 每天一次（14 点以后）她自己“看”一个视频：按口味搜（SEARCH_KEYWORDS，一天一个词）、读字幕摘要和两条热评，记进 <数据目录>/watching/watched.json（最多 30 条、留 30 天）。
//   2. 她心里想事情的时候（ADR 0101 内心）多一个可想的题目：「你最近在 B 站看过的一个东西，你自己怎么想」，事实就是那条字幕摘要 / 热评（真的），想法由她自己定（角色卡管她的口味）；
//      想告诉他 / 想问他的，照旧变成“心里惦记”的主动消息，聊天里照旧带着“你这几个钟头心里在想”。
//   3. 他问到“最近看了什么 / 刷到什么”时，提示词里有她真看过的两条，让她从里面挑说。
// 看的是公开视频的字幕和热评，只存摘要（≤ 220 字）和标题，不存评论者；只看她口味范围内的分区（bilibili.ts 的 CATEGORY_OK / BLOCKED / suitable）。

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { subtitleExcerpt, type SubtitleResult } from '.././bilibili/bilibili-account.ts';
import { rankVideos, searchKeyword, SEARCH_KEYWORDS, type BiliVideo } from '.././bilibili/bilibili.ts';
import { danmakuPeaks, type DanmakuPoint } from '.././bilibili/bilibili-view.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export interface Watched {
    bvid: string;
    title: string;
    owner: string;
    tname: string;
    /** 字幕前面一段（≤ 220 字） */
    excerpt: string;
    /** 热评两条（每条 ≤ 40 字） */
    hot: string[];
    /** 分段章节（ADR 0168）：她自己看的这版比字幕更全一点；读不到就没有 */
    chapters?: { from: number; title: string }[];
    /** 弹幕最密的几段（ADR 0168）：观众在哪儿反应最强烈；读不到就没有 */
    peaks?: { at: number; count: number; samples: string[] }[];
    /** 画面总览（ADR 0168）：B 站切的雪碧图交给看图模型写的一两句；看不成图就没有 */
    frames?: string;
    /** 看的那天 YYYY-MM-DD */
    day: string;
}

export interface WatchedFile { version: 1; entries: Watched[] }

export const WATCHED_KEEP_DAYS = 30;
export const WATCHED_MAX = 30;
/** 这个钟点以后才“看”（白天她在上课 / 忙，下午起空下来） */
export const WATCH_FROM_HOUR = 14;
/** 搜不到合适的，最多换几个关键词再试 */
export const WATCH_KEYWORD_TRIES = 3;
/** 一次最多试几个视频的字幕（有的没有字幕） */
export const WATCH_VIDEO_TRIES = 4;
/** 最近这么久看的才放进“最近在 B 站看过” */
export const WATCHED_FRESH_DAYS = 3;
const MS_DAY = 86_400_000;

const dayText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayNumber = (text: string) => { const [y, m, d] = text.split('-').map(Number) as [number, number, number]; return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY); };

export const watchedPath = (dataDir: string): string => join(dataDir, 'watching', 'watched.json');

export function loadWatched(path: string, log: (message: string) => void = () => undefined): WatchedFile {
    const raw = readJsonOr<Partial<WatchedFile>>(path, {}, message => log(`她看过的：${message}`));
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e): e is Watched => Boolean(e) && typeof e.bvid === 'string' && typeof e.title === 'string' && e.title.trim().length > 0
        && typeof e.owner === 'string' && typeof e.tname === 'string' && typeof e.excerpt === 'string' && e.excerpt.trim().length > 0
        && Array.isArray(e.hot) && e.hot.every(h => typeof h === 'string') && typeof e.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.day))
        .map(e => {
            const chapters = Array.isArray(e.chapters)
                ? e.chapters.filter((chapter): chapter is { from: number; title: string } => Boolean(chapter) && typeof chapter.title === 'string' && Number.isFinite(chapter.from)).slice(0, 8)
                : [];
            const peaks = Array.isArray(e.peaks)
                ? e.peaks.filter(peak => Boolean(peak) && Number.isFinite(peak.at) && Number.isFinite(peak.count)).slice(0, 5)
                    .map(peak => ({ at: peak.at, count: peak.count, samples: Array.isArray(peak.samples) ? peak.samples.filter((s): s is string => typeof s === 'string').slice(0, 3) : [] }))
                : [];
            const frames = typeof e.frames === 'string' && e.frames.trim() ? e.frames.trim().slice(0, 240) : undefined;
            return { ...e, ...(chapters.length ? { chapters } : {}), ...(peaks.length ? { peaks } : {}), ...(frames ? { frames } : {}) };
        });
    return { version: 1, entries };
}

/** 存盘；目录不存在先建（writeJsonAtomic 不建目录——上线第一次存 watching/watched.json 就因为这个失败过） */
export function saveWatched(path: string, file: WatchedFile): void {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, file);
}

/** 过期的去掉、最多留 WATCHED_MAX 条（新的优先） */
export function trimWatched(entries: readonly Watched[], now: Date): Watched[] {
    const today = dayNumber(dayText(now));
    return entries.filter(e => today - dayNumber(e.day) <= WATCHED_KEEP_DAYS).sort((a, b) => b.day.localeCompare(a.day)).slice(0, WATCHED_MAX);
}

/** 今天该不该去“看”一个：到了钟点、今天还没看过 */
export function watchDue(entries: readonly Watched[], now: Date): boolean {
    return now.getHours() >= WATCH_FROM_HOUR && !entries.some(e => e.day === dayText(now));
}

export interface WatchDeps {
    path: string;
    now: () => Date;
    log: (message: string) => void;
    search(keyword: string): Promise<BiliVideo[]>;
    subtitle(video: BiliVideo): Promise<SubtitleResult>;
    hotComments(aid: number): Promise<string[]>;
    /** 章节（ADR 0168，只读）：读不到返回 undefined */
    view?(video: BiliVideo): Promise<{ cid?: number; chapters: { from: number; title: string }[] } | undefined>;
    /** 弹幕（ADR 0168，只读）：读不到返回空数组 */
    danmaku?(cid: number): Promise<readonly DanmakuPoint[]>;
    /** 画面总览图的地址（ADR 0168，只读）：读不到返回空数组 */
    storyboard?(bvid: string, cid: number): Promise<readonly string[]>;
    /** 看一张图（ADR 0168）：给雪碧图写一两句；没有看图能力就不给 */
    describeImage?(url: string): Promise<string | undefined>;
    sleep(ms: number): Promise<void>;
}

/** 关键词：当天的那个，搜不到合适的就换下一个（按顺序往后数） */
export function keywordsFor(day: string): string[] {
    const first = SEARCH_KEYWORDS.indexOf(searchKeyword(day));
    return Array.from({ length: WATCH_KEYWORD_TRIES }, (_, i) => SEARCH_KEYWORDS[(first + i) % SEARCH_KEYWORDS.length]!);
}

/** 看一个：搜 → 排序（跳过看过的、不合口味的）→ 读字幕，有字幕的就是它 → 存下来。没看成返回 'none'，已经看过今天的返回 'done' */
export async function watchOne(deps: WatchDeps): Promise<'watched' | 'none' | 'done'> {
    const now = deps.now();
    const file = loadWatched(deps.path, deps.log);
    if (!watchDue(file.entries, now)) return 'done';
    const day = dayText(now);
    const seen = file.entries.map(e => e.bvid);
    for (const keyword of keywordsFor(day)) {
        let found: BiliVideo[];
        try { found = await deps.search(keyword); } catch (error) {
            deps.log(`她看视频：搜「${keyword}」失败（${error instanceof Error ? error.message : String(error)}）`);
            return 'none';
        }
        const ranked = rankVideos(found, day, seen).slice(0, WATCH_VIDEO_TRIES);
        for (const video of ranked) {
            await deps.sleep(800);
            let excerpt = '';
            try { const result = await deps.subtitle(video); if (result.status === 'ok') excerpt = subtitleExcerpt(result.lines, 220); } catch { /* 这个读不到就换下一个 */ }
            if (!excerpt) continue;
            let hot: string[] = [];
            try { hot = (await deps.hotComments(video.aid)).slice(0, 2).map(c => c.slice(0, 40)); } catch { /* 热评读不到也行 */ }
            // 章节 + 弹幕高能（ADR 0168）：两样都是加分项，读不到就不写，不影响「看过」
            let chapters: { from: number; title: string }[] = [];
            let peaks: { at: number; count: number; samples: string[] }[] = [];
            let cid = video.cid;
            try {
                const view = await deps.view?.(video);
                if (view) {
                    cid = view.cid ?? cid;
                    chapters = view.chapters.slice(0, 6).map(chapter => ({ from: chapter.from, title: chapter.title.slice(0, 20) }));
                }
            } catch { /* 章节读不到就算了 */ }
            try {
                if (deps.danmaku && cid) {
                    const points = await deps.danmaku(cid);
                    peaks = danmakuPeaks(points, { top: 2 }).map(peak => ({ at: peak.at, count: peak.count, samples: peak.samples.slice(0, 3) }));
                }
            } catch { /* 弹幕读不到就算了 */ }
            // 画面总览（ADR 0168）：雪碧图地址 → 交给看图模型写一两句；看不成图就不写
            let frames: string | undefined;
            try {
                if (deps.storyboard && deps.describeImage && cid) {
                    const urls = await deps.storyboard(video.bvid, cid);
                    for (const url of urls.slice(0, 2)) {
                        const described = await deps.describeImage(url);
                        if (described && described.trim()) { frames = described.trim().slice(0, 240); break; }
                    }
                }
            } catch { /* 画面看不成就算了 */ }
            const entry: Watched = {
                bvid: video.bvid, title: video.title.slice(0, 60), owner: video.owner.slice(0, 20), tname: video.category.slice(0, 10), excerpt, hot, day,
                ...(chapters.length ? { chapters } : {}), ...(peaks.length ? { peaks } : {}), ...(frames ? { frames } : {}),
            };
            saveWatched(deps.path, { version: 1, entries: trimWatched([...file.entries, entry], now) });
            deps.log(`她看视频：今天看了一个（${video.category}；字幕 ${[...excerpt].length} 字；热评 ${hot.length} 条）`);
            return 'watched';
        }
    }
    deps.log('她看视频：今天没找到合适的（搜了几个词，都没有能读字幕的新视频）');
    return 'none';
}

// ───────── 放进提示词 ─────────

const fresh = (entries: readonly Watched[], now: Date) => {
    const today = dayNumber(dayText(now));
    return [...entries].filter(e => today - dayNumber(e.day) <= WATCHED_FRESH_DAYS).sort((a, b) => b.day.localeCompare(a.day));
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const describe = (e: Watched, today: string) => `${e.day === today ? '今天' : `${e.day.slice(5)}`}看的《${e.title}》（UP 主「${e.owner}」，${e.tname}）：字幕大意——${e.excerpt}${e.hot.length ? `；热评里有人说：${e.hot.join(' / ')}` : ''}${e.chapters?.length ? `；分段：${e.chapters.map(chapter => `${clock(chapter.from)} ${chapter.title}`).join('、')}` : ''}${e.peaks?.length ? `；观众反应最强烈：${e.peaks.map(peak => `${peak.at} 秒（${peak.count} 条弹幕）`).join('、')}` : ''}${e.frames ? `；画面总览：${e.frames}` : ''}`;

/** 她心里想事情时用的事实（只放最近一条，免得总想同一堆）；id 是这个视频的编号（想过的记下来，不再专门想）；没有就 undefined */
export function watchedFacts(entries: readonly Watched[], now: Date): { id: string; text: string } | undefined {
    const latest = fresh(entries, now)[0];
    return latest ? { id: latest.bvid, text: describe(latest, dayText(now)) } : undefined;
}

/** 他问到“最近看了什么 / 刷到什么 / B 站” */
const ASKS_WATCHED = /最近(?:在)?(?:看|刷|追)|看了(?:什么|啥|个|点)|刷到(?:什么|啥|个)|在看什么|看啥|B ?站|b ?站|bilibili|视频/;

export function watchedLine(entries: readonly Watched[], history: readonly { role: 'user' | 'assistant'; content: string }[], now: Date): string | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    if (!ASKS_WATCHED.test(said)) return undefined;
    const list = fresh(entries, now).slice(0, 2);
    if (!list.length) return undefined;
    const today = dayText(now);
    return `[你最近在 B 站看过的（真看过，读了字幕；想法是你自己的，可以赞同、不以为然、觉得好笑，细节别编）：${list.map(e => describe(e, today)).join('｜')}。他问起你最近看了什么，就从这里挑一个说，随口说，别照着念字幕]`;
}
