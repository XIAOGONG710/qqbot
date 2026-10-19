// 她刷 B 站，刷到一个真的视频，发给他看并说一句感受（ADR 0084）。
// 以前「刷到视频」是禁区（ADR 0013 决策 2：模型会编出一个具体的视频，对方要链接时给不出来）。现在视频是真的：
// 从 B 站公开的热门榜里按她的口味挑一个，连热评一起读（只读公开接口，不登录、不发任何东西到 B 站），
// 让她用主动找他的方式（responder.initiate）说一句感受，再把真的链接跟在后面。
// 在 B 站评论区评论、@ 他的账号需要登录一个 B 站账号，有封号风险和公开关联身份的问题，这里没有做（见 ADR）。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { InitiateOutcome, InitiateRequest } from './responder.ts';
import { pick } from './reply-timing.ts';
import { formatDate, herDay, stateAt, type ExtraFreeActivity, type Schedule } from './schedule.ts';

export interface BiliVideo {
    bvid: string;
    aid: number;
    title: string;
    desc: string;
    owner: string;
    category: string;
    views: number;
    likes: number;
    /** 秒 */
    duration: number;
    link: string;
}

/** 和全局 fetch 兼容的最小形状（测试注入假的） */
export type BiliFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
};
const TIMEOUT_MS = 10_000;

async function getJson(doFetch: BiliFetch, url: string): Promise<unknown> {
    const response = await doFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
    const json = JSON.parse(await response.text()) as { code?: number; message?: string; data?: unknown };
    if (json.code !== 0) throw new Error(`B 站接口 code ${String(json.code)}（${String(json.message ?? '')}）`);
    return json.data;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 热门榜（公开，不用登录）：最多 pages 页，每页 20 个 */
export async function fetchPopular(doFetch: BiliFetch, pages = 2): Promise<BiliVideo[]> {
    const videos: BiliVideo[] = [];
    for (let page = 1; page <= pages; page++) {
        const data = (await getJson(doFetch, `https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${page}`)) as { list?: unknown[] } | null;
        for (const raw of data?.list ?? []) {
            const item = raw as { bvid?: unknown; aid?: unknown; title?: unknown; desc?: unknown; owner?: { name?: unknown }; tname?: unknown; stat?: { view?: unknown; like?: unknown }; duration?: unknown };
            const bvid = str(item.bvid);
            if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !str(item.title)) continue;
            videos.push({
                bvid, aid: num(item.aid), title: str(item.title), desc: str(item.desc), owner: str(item.owner?.name), category: str(item.tname),
                views: num(item.stat?.view), likes: num(item.stat?.like), duration: num(item.duration), link: `https://www.bilibili.com/video/${bvid}`,
            });
        }
    }
    return videos;
}

/** 热评前 n 条的正文（去掉 @、网址、换行，截短；太短、太长的不要） */
export async function fetchHotComments(doFetch: BiliFetch, aid: number, n = 3): Promise<string[]> {
    const data = (await getJson(doFetch, `https://api.bilibili.com/x/v2/reply/main?oid=${aid}&type=1&mode=3&ps=${n + 4}`)) as { replies?: { content?: { message?: unknown } }[] } | null;
    const comments: string[] = [];
    for (const reply of data?.replies ?? []) {
        const text = str(reply.content?.message).replace(/\[[^\]]{1,8}\]/g, '').replace(/\s+/g, ' ').trim();
        if (text.length < 6 || text.length > 60 || /@|https?:|www\.|\d{6,}/.test(text)) continue;
        comments.push(text);
        if (comments.length >= n) break;
    }
    return comments;
}

/** 她会点开的分区（日常、搞笑、萌宠、美食、音乐、影视、游戏……）；社会、资讯、法律、明星、电竞赛事不要 */
export const CATEGORY_OK: ReadonlySet<string> = new Set([
    '日常', '搞笑', '小剧场', '鬼畜剧场', '动物综合', '喵星人', '汪星人', '动物圈', '田园美食', '美食制作', '美食侦探', '美食测评',
    '音乐综合', '翻唱', '演奏', '原创音乐', '影视剪辑', '影视杂谈', '动漫杂谈', '单机游戏', '手机游戏', '网络游戏', '科学科普', '野生技术协会',
    '运动综合', '出行', '摄影摄像', '数码', '综合', '绘画', '手工', '穿搭', '风光', '旅游',
]);

/** 标题或简介里有这些就不要（营销、争议、吓人的） */
const BLOCKED = /广告|商单|恰饭|抽奖|转发|赞助|优惠|购买|直播间|政治|战争|军事|新闻|事故|死亡|去世|车祸|血腥|恐怖|惊悚|疫情|股票|基金|炒|彩票|代孕|赌/;

export const MAX_DURATION_S = 12 * 60;

export function suitable(video: BiliVideo): boolean {
    return CATEGORY_OK.has(video.category) && video.duration >= 20 && video.duration <= MAX_DURATION_S && video.title.length <= 60 && !BLOCKED.test(`${video.title} ${video.desc}`);
}

/** 从合适的、没发过的里按日期哈希挑一个；没有返回 undefined */
export function pickVideo(videos: readonly BiliVideo[], day: string, seen: readonly string[]): BiliVideo | undefined {
    const pool = videos.filter(video => suitable(video) && !seen.includes(video.bvid)).sort((a, b) => a.bvid.localeCompare(b.bvid));
    return pool.length ? pool[pick(day, 'bili-video', [0, pool.length - 1])] : undefined;
}

/** 提示词里的说明（initiate 的 note）：只给事实和方向，不给台词；链接之后自动附上，不要她写 */
export function videoNote(video: BiliVideo, comments: readonly string[], userName: string): string {
    const facts = [`《${video.title}》`, `UP 主：${video.owner}`, `分区：${video.category}`, `约 ${Math.max(1, Math.round(video.duration / 60))} 分钟`,
        ...(video.desc && video.desc !== '-' ? [`简介：${video.desc.slice(0, 60)}`] : []),
        ...(comments.length ? [`热评：${comments.map(text => `「${text}」`).join('')}`] : [])];
    return `你刚在 B 站刷到一个视频，觉得${userName}也会想看，发给他：${facts.join('；')}。`
        + `只说你看了之后真实的一句感受或吐槽${comments.length ? '（可以接热评的梗）' : ''}，一两句；视频里没写的内容不编，不说你看到了哪一段、看了多久；链接会自动跟在后面，你不用写链接和标题全名`;
}

export const videoTopic = (userName: string) => `${userName}最近喜欢看什么视频、刷什么`;

// ───────── 每分钟看一眼 ─────────

export const VIDEO_CHANCE = 0.3;
export const VIDEO_MIN_GAP_MS = 36 * 3_600_000;
export const VIDEO_WEEK_MAX = 3;
const CACHE_MS = 3 * 3_600_000;
const FAIL_RETRY_MS = 15 * 60_000;
/** 一直取不到（多半是被风控了）就越隔越久：15、30、60、120 分钟，之后每 2 小时；取到一次就从头 */
const FAIL_RETRY_MAX_MS = 2 * 3_600_000;
const BUSY_RETRY_MS = 20 * 60_000;

/** 这一天（她的一天）刷不刷、几点（当天的分钟数：工作日晚上，周末下午到晚上）；不刷返回 undefined */
export function videoPlan(day: string, weekend: boolean): { minutes: number } | undefined {
    if (pick(day, 'bili', [0, 999]) >= VIDEO_CHANCE * 1000) return undefined;
    return { minutes: weekend ? pick(day, 'bili-at', [14 * 60, 22 * 60 + 30]) : pick(day, 'bili-at', [19 * 60, 22 * 60 + 30]) };
}

interface VideoFile {
    version: 1;
    seen: string[];
    shares: { at: number; bvid: string; title: string; mode: 'dryRun' | 'on' }[];
    attemptDay?: string;
    cache?: { at: number; list: BiliVideo[] };
}

const validFile = (value: unknown): value is VideoFile =>
    typeof value === 'object' && value !== null && (value as VideoFile).version === 1 && Array.isArray((value as VideoFile).seen) && Array.isArray((value as VideoFile).shares);

export interface VideoBrowsingOptions {
    mode: 'dryRun' | 'on';
    /** 发给谁：男朋友档的联系人 */
    target: { qq: number; name: string };
    schedule: Schedule;
    extraFree?: readonly ExtraFreeActivity[];
    dir: string;
    now: () => number;
    log: (message: string) => void;
    saidSleep?: (now: number) => boolean;
    fetch: BiliFetch;
    /** 主动找他一次（responder.initiate） */
    initiate: (request: InitiateRequest) => Promise<InitiateOutcome>;
    /** 把真链接作为下一条发出去，记进聊天记录（content 里带标题，她之后知道自己发过什么） */
    sendLink: (video: BiliVideo) => Promise<void>;
}

export interface VideoBrowsing {
    tick(): Promise<void>;
    start(): void;
    stop(): void;
}

export function createVideoBrowsing(options: VideoBrowsingOptions): VideoBrowsing {
    const { schedule, log, target } = options;
    mkdirSync(options.dir, { recursive: true });
    const statePath = join(options.dir, 'bilibili.json');
    const state = readJsonOr<VideoFile>(statePath, { version: 1, seen: [], shares: [] }, log, { validate: validFile, label: '刷 B 站状态' });
    const save = () => writeJsonAtomic(statePath, state);
    let retryAt = 0;
    let busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let failedLogged = false;
    let failures = 0;

    async function tick(): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            const t = options.now();
            if (t < retryAt) return;
            const date = new Date(t);
            const day = formatDate(herDay(schedule, date));
            if (state.attemptDay === day) return;
            const current = stateAt(schedule, date, options.extraFree ?? []);
            if (current.activity.kind !== 'free' && current.activity.kind !== 'between') return;
            if (options.saidSleep?.(t)) return;
            const plan = videoPlan(day, date.getDay() === 0 || date.getDay() === 6);
            if (!plan || date.getHours() * 60 + date.getMinutes() < plan.minutes) return;
            const last = state.shares.at(-1);
            if ((last && t - last.at < VIDEO_MIN_GAP_MS) || state.shares.filter(share => t - share.at < 7 * 86_400_000).length >= VIDEO_WEEK_MAX) return;

            if (!state.cache || t - state.cache.at > CACHE_MS) {
                try {
                    state.cache = { at: t, list: (await fetchPopular(options.fetch)).filter(suitable) };
                    save();
                    failedLogged = false;
                    failures = 0;
                } catch (error) {
                    retryAt = t + Math.min(FAIL_RETRY_MS * 2 ** failures, FAIL_RETRY_MAX_MS);
                    failures++;
                    if (!failedLogged) {
                        failedLogged = true;
                        log(`刷 B 站：取热门榜失败（之后不再记，隔一会儿再试，越隔越久）：${error instanceof Error ? error.message : String(error)}`);
                    }
                    return;
                }
            }
            const video = pickVideo(state.cache.list, day, state.seen);
            if (!video) {
                state.attemptDay = day;
                save();
                log('刷 B 站：热门榜里没有她会点开的新视频，今天不刷了');
                return;
            }
            const comments = await fetchHotComments(options.fetch, video.aid).catch(() => [] as string[]);
            const outcome = await options.initiate({
                label: 'B 站视频',
                note: videoNote(video, comments, target.name),
                topic: videoTopic(target.name),
                maxBubbles: 2,
                dryRun: options.mode === 'dryRun',
                commit: () => {
                    state.shares.push({ at: t, bvid: video.bvid, title: video.title, mode: options.mode });
                    state.shares = state.shares.slice(-100);
                    state.seen = [...state.seen, video.bvid].slice(-200);
                    state.attemptDay = day;
                    save();
                },
            });
            switch (outcome.result) {
                case 'sent':
                    try {
                        await options.sendLink(video);
                        log(`刷 B 站：发给他《${video.title}》和链接`);
                    } catch (error) {
                        log(`刷 B 站：话发出去了，链接没发成：${error instanceof Error ? error.message : String(error)}`);
                    }
                    break;
                case 'dryRun': {
                    appendFileSync(join(options.dir, 'drafts.md'), `## ${new Date(t).toLocaleString('zh-CN')} 刷到的 B 站视频（草稿，没发）\n\n${outcome.parts.join('\n')}\n\n（${video.title}　${video.link}）\n\n`);
                    log(`刷 B 站（试运行，没发）：《${video.title}》，她的话写进了 drafts.md`);
                    break;
                }
                case 'skipped':
                    // 正在聊着、有没回的消息：过一会儿再试，今天的机会不算用掉
                    retryAt = t + BUSY_RETRY_MS;
                    break;
                case 'failed':
                    state.attemptDay = day;
                    save();
                    log(`刷 B 站：这次没发成（${outcome.reason}）`);
                    break;
            }
        } finally {
            busy = false;
        }
    }

    return {
        tick,
        start() {
            if (timer) return;
            void tick();
            timer = setInterval(() => void tick(), 60_000);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = undefined;
        },
    };
}
