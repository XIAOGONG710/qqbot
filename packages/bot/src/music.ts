// 分享一首歌（ADR 0139，配置 musicShares，默认关）：情侣之间最常见的小事之一——“这首好听”，一张歌曲卡片，一句话。
// 歌从网易云的公开榜单（飙升榜、新歌榜、热歌榜、原创榜）里来，不是她“一直爱听”的编造的口味；歌词只取两句（歌词接口读得到的），让她能说到点子上、不凭空评价。
// 每天刷一次候选（最多 MUSIC_PICKS 首：能播、不是 DJ / 伴奏 / 翻唱 / 变速，歌词里没有脏话 / 危机相关的词），存在 <数据目录>/music/music.json（派生数据，可以删，会重新刷）。
// 什么时候发、发几次由主动消息的计划器管（news 的新一类 music_share，world.ts）；这里只管“候选在不在”“上一首发了多久”（相隔 MUSIC_GAP_DAYS 天以上）。
// 全是公开接口、只读；失败一律当没有候选（不发），不影响别的。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectCrisis } from './crisis.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface MusicPick {
    /** 网易云歌曲 id（歌曲卡片用） */
    id: number;
    title: string;
    artist: string;
    /** 来自哪个榜 */
    chart: string;
    /** 歌词里的一两句（副歌优先） */
    lyric: string[];
}
export interface MusicState {
    version: 1;
    picks: MusicPick[];
    /** 发过的歌 id → 时间（ISO），一直留 MUSIC_KEEP_SHARED_DAYS 天，免得过两个月又发同一首 */
    shared: Record<string, string>;
    /** 上一次刷候选的时刻（ISO） */
    updatedAt?: string;
}

export const MUSIC_CHARTS = [
    { id: 19723756, name: '飙升榜' }, { id: 3779629, name: '新歌榜' }, { id: 3778678, name: '热歌榜' }, { id: 2884035, name: '原创榜' },
] as const;
/** 多久看一眼该不该刷候选、隔多久最多刷一次 */
export const MUSIC_CHECK_MS = 6 * HOUR;
export const MUSIC_REFRESH_MS = 20 * HOUR;
/** 一次最多留几首候选 */
export const MUSIC_PICKS = 12;
/** 发过的歌多久之内不再发 */
export const MUSIC_KEEP_SHARED_DAYS = 90;
/** 上一首发出去之后，隔这么多天以上才发下一首（一周最多两首） */
export const MUSIC_GAP_DAYS = 3;
/** 一首歌的时长范围（毫秒）：太短的是片段，太长的是串烧 */
const DURATION: [number, number] = [90_000, 7 * 60_000];

export interface Track { id: number; name: string; artists: string[]; duration: number; playable: boolean }

/** 不要的版本：DJ、伴奏、纯音乐、翻唱、现场、变速、铃声…… */
const BAD_TITLE = /DJ|伴奏|纯音乐|remix|铃声|翻唱|cover|live|现场|抖音|女声版|男声版|变速|加速|降调|升调|0\.\d+x|inst\.?|instrumental|版本|ver\./i;
/** 歌词里不要的：脏话 / 性暗示（她随口分享，不该带这些）。只认明确的说法：「操场」「逼近」「滚烫」「傻笑」这类正常的词不能误伤 */
const BAD_LYRIC = /傻逼|煞笔|沙比|装逼|牛逼|他妈|妈的|操你|操他|操蛋|艹|屌|婊|贱人|滚蛋|做爱|上床|裸体|裸照|约炮|fuck|shit|bitch/i;

/** 榜单接口返回的曲目 → Track（不认识的结构返回空） */
export function parseChart(raw: unknown): Track[] {
    const tracks = (raw as { result?: { tracks?: unknown } } | null)?.result?.tracks;
    if (!Array.isArray(tracks)) return [];
    return tracks.flatMap(item => {
        const t = item as { id?: unknown; name?: unknown; artists?: unknown; duration?: unknown; status?: unknown } | null;
        if (typeof t?.id !== 'number' || typeof t.name !== 'string' || !Array.isArray(t.artists)) return [];
        const artists = t.artists.map(a => (a as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
        return [{ id: t.id, name: t.name.trim(), artists, duration: typeof t.duration === 'number' ? t.duration : 0, playable: t.status === 0 }];
    });
}

/** 能当候选的曲目：能播、有歌手、时长合适、不是不要的版本 */
export function usableTrack(track: Track): boolean {
    return track.playable && track.artists.length > 0 && track.name !== '' && track.duration >= DURATION[0] && track.duration <= DURATION[1] && !BAD_TITLE.test(track.name)
        && !track.artists.some(name => /未知|various|群星/i.test(name));
}

const TIME_TAG = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g;
const CREDIT_KEY = /^(?:作词|作曲|编曲|制作人?|录音|混音|母带|监制|策划|出品|发行|吉他|贝斯|鼓|和声|词|曲|编|演唱|原唱|歌手|OP|SP|Lyrics|Music|Produced|Arranged)\b/i;
/** 歌词里的段落标记（"verse 2"、"[Chorus]"、"Intro"）：不是歌词 */
const SECTION = /^[[(（【]?\s*(?:verse|chorus|bridge|hook|intro|outro|pre-?chorus|interlude|solo|间奏|前奏|尾奏|主歌|副歌)\s*\d*\s*[\])）】]?$/i;

/** 歌词原文 → 去掉时间标签和署名行的歌词行 */
export function lyricLines(lrc: string): string[] {
    const lines = lrc.split('\n').map(line => line.replace(TIME_TAG, '').trim()).filter(Boolean);
    return lines.filter((line, i) => !(CREDIT_KEY.test(line) && /[：:]/.test(line)) && !(i < 12 && /^[^\s：:]{1,6}\s*[：:]\s*\S/.test(line) && [...line].length <= 24) && /[\p{Script=Han}A-Za-z]/u.test(line) && !SECTION.test(line));
}

/** 这几句是不是以中文为主（她是青岛的大学生，随口分享的歌以中文歌为主；俄语 / 日语 / 全英文的不要） */
export function mostlyChinese(lines: readonly string[]): boolean {
    const text = lines.join('');
    const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
    const letters = (text.match(/[\p{Script=Han}\p{Letter}]/gu) ?? []).length;
    return letters > 0 && han / letters >= 0.6;
}

/**
 * 挑两句：重复最多的那一句（副歌）加它后面的一句；没有重复就取歌的前半段中间的两句。每句 4–24 个字。
 * 整首歌词里有脏话 / 危机相关的词，返回空（这首不要）
 */
export function pickLyric(lrc: string): string[] {
    const lines = lyricLines(lrc);
    if (lines.length < 4) return [];
    if (lines.some(line => BAD_LYRIC.test(line) || detectCrisis(line))) return [];
    const size = (line: string) => [...line].length;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    const fit = (line: string) => size(line) >= 4 && size(line) <= 24;
    // 先找重复最多的“相邻两句”（副歌通常是整段重复）；没有就取重复最多的一句和它后面的一句；再没有就取前半段中间的两句
    const pairs = new Map<string, number>();
    for (let i = 0; i + 1 < lines.length; i++) {
        if (!fit(lines[i]!) || !fit(lines[i + 1]!) || lines[i] === lines[i + 1]) continue;
        const key = `${lines[i]}\t${lines[i + 1]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const pair = [...pairs].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (pair) return pair.split('\t');
    const chorus = [...counts].filter(([line, n]) => n >= 2 && fit(line)).sort((x, y) => y[1] - x[1] || lines.indexOf(x[0]) - lines.indexOf(y[0]))[0]?.[0];
    const start = chorus !== undefined ? lines.indexOf(chorus) : Math.floor(lines.length * 0.35);
    const picked: string[] = [];
    for (const line of lines.slice(start)) {
        if (fit(line) && !picked.includes(line)) picked.push(line);
        if (picked.length >= 2) break;
    }
    return picked;
}

/** 候选还没发过的第一首；上一首发出去不到 MUSIC_GAP_DAYS 天就没有 */
export function readyPick(state: MusicState, now: number): MusicPick | undefined {
    if (Object.values(state.shared).some(at => now - Date.parse(at) < MUSIC_GAP_DAYS * DAY)) return undefined;
    return state.picks.find(pick => !(String(pick.id) in state.shared));
}

/** 发出去了：记下来，90 天之前的忘掉 */
export function markShared(state: MusicState, id: number, now: number): MusicState {
    const shared = Object.fromEntries(Object.entries(state.shared).filter(([, at]) => now - Date.parse(at) < MUSIC_KEEP_SHARED_DAYS * DAY));
    shared[String(id)] = new Date(now).toISOString();
    return { ...state, shared };
}

/** 提示词里这首歌的几行事实：歌名、歌手、来自哪个榜、歌词的一两句；没写的（歌的故事、她听了多少遍）不编 */
export function describeMusic(pick: MusicPick): string {
    const lyric = pick.lyric.length ? `歌词里有这几句：${pick.lyric.map(line => `「${line}」`).join('')}。` : '';
    return `[这首歌：《${pick.title}》，${pick.artist}（网易云${pick.chart}上的）。${lyric}这些是你知道的全部：歌的故事、歌手的事、你听了多少遍、它陪你过什么，都别编；评价只说你听着的感觉；引歌词最多一句，不要整段念]`;
}

// ── 发卡片 ──

export interface ShareMusicDeps {
    /** 发网易云歌曲卡片（OneBot music 段）；没有就只发文字链接 */
    sendMusic?: (userId: number, id: number) => Promise<number>;
    sendText: (userId: number, text: string) => Promise<number>;
    log: (message: string) => void;
}

/** 发一张歌曲卡片；NapCat 不认 / 出错就改发文字链接兜底；超时不重发（可能已经发出去了，再发就重复） */
export async function shareMusicCard(deps: ShareMusicDeps, userId: number, pick: MusicPick): Promise<number> {
    const link = `${pick.title} - ${pick.artist}\nhttps://music.163.com/song?id=${pick.id}`;
    if (!deps.sendMusic) return deps.sendText(userId, link);
    try {
        return await deps.sendMusic(userId, pick.id);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (/timeout|timed out|超时/i.test(reason)) throw error;
        deps.log(`歌曲卡片没发出去（${reason}），改发文字链接`);
        return deps.sendText(userId, link);
    }
}

// ── 存取 ──

export function loadMusic(path: string, log: (message: string) => void = () => undefined): MusicState {
    const empty: MusicState = { version: 1, picks: [], shared: {} };
    if (!existsSync(path)) return empty;
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as MusicState;
        if (value?.version !== 1 || !Array.isArray(value.picks) || typeof value.shared !== 'object' || value.shared === null) throw new Error('结构不对');
        return {
            ...value,
            picks: value.picks.filter(p => typeof p?.id === 'number' && typeof p.title === 'string' && typeof p.artist === 'string' && Array.isArray(p.lyric)),
        };
    } catch (error) {
        log(`分享歌曲：文件读不了（${error instanceof Error ? error.message : String(error)}），当作没有；原文件不动`);
        return empty;
    }
}

export function saveMusic(path: string, state: MusicState): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
}

export const musicPath = (dataDir: string) => join(dataDir, 'music', 'music.json');

// ── 刷候选 ──

export type MusicGet = (url: string) => Promise<unknown>;

/** 默认的读法：公开接口，带个浏览器的 UA 和 Referer，15 秒超时 */
export const musicGet: MusicGet = async url => {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
};

const unit = (text: string): number => {
    let h = 0x811c9dc5;
    for (const char of text) { h ^= char.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 0x1_0000_0000;
};

export interface RefreshMusicOptions {
    path: string;
    now: () => number;
    log: (message: string) => void;
    get?: MusicGet;
    sleep?: (ms: number) => Promise<void>;
}

/** 该不该刷、刷一次；返回刷出来的候选数（没到时间返回 undefined）。失败不抛，留着旧的 */
export async function refreshMusic(options: RefreshMusicOptions): Promise<number | undefined> {
    const get = options.get ?? musicGet;
    const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = options.now();
    const state = loadMusic(options.path, options.log);
    if (state.updatedAt && now - Date.parse(state.updatedAt) < MUSIC_REFRESH_MS) return undefined;
    const day = new Date(now).toDateString();
    const tracks: { track: Track; chart: string }[] = [];
    for (const chart of MUSIC_CHARTS) {
        try {
            for (const track of parseChart(await get(`https://music.163.com/api/playlist/detail?id=${chart.id}`))) {
                if (usableTrack(track) && !(String(track.id) in state.shared) && !tracks.some(t => t.track.id === track.id)) tracks.push({ track, chart: chart.name });
            }
        } catch (error) {
            options.log(`分享歌曲：读${chart.name}失败（${error instanceof Error ? error.message : String(error)}）`);
        }
        await sleep(400);
    }
    if (!tracks.length) return undefined;
    // 按日期洗牌，同一天每次一样；挨个读歌词，读不到 / 不合适的跳过，凑够 MUSIC_PICKS 首
    const shuffled = [...tracks].sort((a, b) => unit(`${day} ${a.track.id}`) - unit(`${day} ${b.track.id}`));
    const picks: MusicPick[] = [];
    for (const { track, chart } of shuffled) {
        if (picks.length >= MUSIC_PICKS) break;
        try {
            const raw = await get(`https://music.163.com/api/song/lyric?id=${track.id}&lv=-1&tv=-1`);
            const lyric = pickLyric(String((raw as { lrc?: { lyric?: unknown } } | null)?.lrc?.lyric ?? ''));
            if (lyric.length && mostlyChinese(lyric)) picks.push({ id: track.id, title: track.name, artist: track.artists.slice(0, 2).join('/'), chart, lyric });
        } catch (error) {
            options.log(`分享歌曲：读歌词失败（${error instanceof Error ? error.message : String(error)}）`);
        }
        await sleep(400);
    }
    if (!picks.length) return undefined;
    saveMusic(options.path, { ...state, picks, updatedAt: new Date(now).toISOString() });
    options.log(`分享歌曲：刷了一次候选，现在有 ${picks.length} 首（日志不记歌名）`);
    return picks.length;
}

// ── 他发来的歌（ADR 0139 第二部分）──
// 他发来的音乐卡片原来就看得懂（shares.ts 写成「[分享音乐：歌名 - 歌手]」），但她只知道歌名和歌手，接不出像样的话。
// 这里按歌名 + 歌手到网易云搜一下、读两句歌词给她，让她能说“哪句戳我”或者问他为什么发这首；搜不到就只有歌名和歌手。

const SHARED_SONG = /\[分享音乐：([^\]\n]+?)(?: - ([^\]\n]+))?\]/g;

/** 他这一串话里最后一张音乐卡片（聊天记录里的写法）；没有就 undefined */
export function sharedSong(text: string): { title: string; artist?: string } | undefined {
    const match = [...text.matchAll(SHARED_SONG)].at(-1);
    if (!match) return undefined;
    const title = match[1]!.trim();
    return title ? { title, ...(match[2]?.trim() ? { artist: match[2].trim() } : {}) } : undefined;
}

const norm = (text: string) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/** 按歌名 + 歌手搜：歌名对得上（去掉空格标点、大小写）且歌手对得上的第一首；搜不到 / 接口出错返回 undefined */
export async function findSong(get: MusicGet, song: { title: string; artist?: string }): Promise<Pick<MusicPick, 'id' | 'title' | 'artist'> | undefined> {
    const raw = await get(`https://music.163.com/api/search/get?s=${encodeURIComponent(`${song.title} ${song.artist ?? ''}`.trim())}&type=1&limit=5&offset=0`);
    const songs = (raw as { result?: { songs?: unknown } } | null)?.result?.songs;
    if (!Array.isArray(songs)) return undefined;
    for (const item of songs) {
        const s = item as { id?: unknown; name?: unknown; artists?: unknown } | null;
        if (typeof s?.id !== 'number' || typeof s.name !== 'string' || !Array.isArray(s.artists)) continue;
        const artists = s.artists.map(a => (a as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string');
        const sameTitle = norm(s.name) === norm(song.title) || norm(s.name).startsWith(norm(song.title));
        const sameArtist = !song.artist || artists.some(name => norm(name) && (norm(song.artist!).includes(norm(name)) || norm(name).includes(norm(song.artist!))));
        if (sameTitle && sameArtist) return { id: s.id, title: s.name.trim(), artist: artists.slice(0, 2).join('/') || song.artist || '' };
    }
    return undefined;
}

/** 他发来的这首歌的信息：搜得到再读歌词（取两句）；歌词读不到 / 不合适就只有歌名和歌手；全部出错返回只有歌名歌手的 */
export async function lookupSong(get: MusicGet, song: { title: string; artist?: string }): Promise<MusicPick> {
    const plain: MusicPick = { id: 0, title: song.title, artist: song.artist ?? '', chart: '他发来的', lyric: [] };
    try {
        const found = await findSong(get, song);
        if (!found) return plain;
        const raw = await get(`https://music.163.com/api/song/lyric?id=${found.id}&lv=-1&tv=-1`);
        return { id: found.id, title: song.title, artist: song.artist ?? found.artist, chart: '他发来的', lyric: pickLyric(String((raw as { lrc?: { lyric?: unknown } } | null)?.lrc?.lyric ?? '')) };
    } catch {
        return plain;
    }
}

/** 提示词里他发来的歌：歌名、歌手、歌词的几句（有才有）；她没听、不知道歌的故事，说哪句戳她或者问他为什么发这首 */
export function describeHisSong(pick: MusicPick): string {
    const lyric = pick.lyric.length ? `歌词里有这几句：${pick.lyric.map(line => `「${line}」`).join('')}。你点开看了歌词（他看不到你看的歌词：说到哪一句就把那一句原样写出来，别只说“这句”），` : '你没点开听，';
    return `[他发来了一首歌：《${pick.title}》${pick.artist ? `，${pick.artist}` : ''}。${lyric}这些是你知道的全部：你以前有没有听过、歌的故事、歌手的事、前奏编曲唱得怎么样，都别编；接他的话——说哪句戳你，或者问他为什么发这首、是不是最近在听；一两句就好，别评价得太专业]`;
}
