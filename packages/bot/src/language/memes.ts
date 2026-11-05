// 她知道网上现在流行的梗（ADR 0129，配置 memes，默认关；要 bilibiliAccount 开着才会自己去学）。
// 用户 10-23：「现在网络上热门的梗她基本没有了解」。原因：她的知识停在模型训练的那一天，之后的梗她一个都不知道；
// 他拿新梗逗她，她要么装没听懂，要么按字面接，要么凭印象解释错。表情包 / 小梗（ADR 0114）管的是别的事。
// 做法（每 12 小时一次，派生数据，不碰角色卡）：
//   1. 公开热榜：B 站热门视频标题、B 站热搜、微博热搜、百度热榜（匿名就能读；知乎要登录、小鸡词典打不开）。
//   2. 让模型从标题里挑出**可能是梗 / 流行语**的词（最多 12 个；不要新闻、政治、灾害、案件、八卦、游戏版本号、广告、句式模板）。
//   3. 每个新词，用她自己的 B 站号搜「<词> 什么梗」，读几个视频的**字幕**、简介和热评当证据；让模型**只根据证据**写意思、例句、有没有把握、适不适合聊天。
//      只看标题 / 简介 / 热评证据太薄（试过：5 个词 1 个认不出、3 个只有“低”把握）；加上字幕以后 6 个词里 5 个有“中 / 高”把握的解释，句式模板那个被正确地判成不是梗。
//   4. 代码再过一遍：把握必须是中 / 高、适合聊天必须是 true、意思 6–60 字、例句 ≤ 24 字、不碰敏感词；45 天没再在榜上出现的过期，最多留 40 个。
// 用在聊天里（只对男朋友档，和小梗一样放进提示词）：
//   - 他这一句里用了库里的梗：给她这个梗的意思，让她顺着接——别说“没听懂”、别解释梗、别拆梗。
//   - 没用到的话，约 MEME_TURN_SHARE 的轮次给她 3 个最近的梗当“你最近刷到的”：每条带「意思 / 为什么好笑 / 什么时候合适 / 什么时候别用」，
//     让她先判断场合合不合用（2026-10-29 用户：不能只给意思，要理解为什么有这个梗、什么时候不该用）。
//     只有带 why 和 avoid 的才主动往外用——说不清失效条件的梗只在他自己用的时候给她意思。
//     参照 QiDouZu/retcon-form：结论是压缩包，要能解压回「它凭什么成立、什么情况下它错」。
// 她的话里最近原样出现过的梗不再放（别总用同一个）。

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { subtitleExcerpt, type SubtitleResult } from '.././bilibili/bilibili-account.ts';
import { BLOCKED, type BiliVideo } from '.././bilibili/bilibili.ts';
import { unit } from './expression.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export interface MemeEntry {
    term: string;
    /** 一句话：什么意思、通常在什么情形下用 */
    meaning: string;
    /** 这个梗从哪来的：哪个事件、哪句话被反复用（2026-10-29，照 retcon-form 的「压缩包要能解压」） */
    origin?: string;
    /** 为什么好笑 / 它拧的是哪个预期（"为什么会有这个梗"） */
    why?: string;
    /** 什么时候用合适：在谁之间、什么情绪下、多熟的关系 */
    when?: string;
    /** **失效条件**：什么时候用它就错了（对他认真的时候、涉及身材/地域、过期了、长辈在场……），缺这条就不主动往外用 */
    avoid?: string;
    /** 一个聊天里随口说的例句（只给人看，不放进提示词，免得她照抄） */
    example: string;
    confidence: 'high' | 'mid';
    /** YYYY-MM-DD */
    firstSeen: string;
    lastSeen: string;
    /** 在榜上出现过几次（每次刷新算一次） */
    seen: number;
}

export interface MemeFile {
    version: 1;
    /** 上一次刷新的时间（ISO） */
    refreshedAt?: string;
    entries: MemeEntry[];
}

export const MEME_REFRESH_MS = 6 * 60 * 60_000;
export const MEME_KEEP_DAYS = 45;
export const MEME_MAX = 40;
/** 一次刷新最多给几个新词找证据、写解释（每个词要搜一次 B 站、读几个字幕） */
export const MEME_EXPLAIN_PER_RUN = 8;
export const MEME_CANDIDATES_MAX = 12;
/** 没用到梗的轮次里，约这么多给她看“最近刷到的” */
export const MEME_TURN_SHARE = 0.2;
/** 她最近这么多天说过的梗不再放 */
export const MEME_COOLDOWN_MS = 3 * 24 * 3_600_000;
/** “最近刷到的”只从这么多天内还在榜上的里挑 */
export const MEME_FRESH_DAYS = 30;

/** 梗和解释里不要的：政治、灾难、案件、骂人、低俗、地域 / 性别攻击（在 B 站的 BLOCKED 之外再加） */
export const MEME_BLOCK = /政|党|总统|领导人|战争|军事|地震|灾|死|杀|案|警方|疫情|台独|港独|辱|骂|黑人|女拳|男拳|直男癌|拳师|屌|逼|操|草泥马|傻[逼比]|nmsl|cnm|[Ss][Bb]|婊|嫖|约炮|成人|涉黄|脱衣/;

const MS_DAY = 86_400_000;
const dayText = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayNumber = (text: string) => { const [y, m, d] = text.split('-').map(Number) as [number, number, number]; return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY); };
const chars = (text: string) => [...text].length;
const clean = (value: unknown) => String(value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** Cancel a pure read/model wait locally without authorizing its late result. */
async function memeRead<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    let abort: (() => void) | undefined;
    const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); }) : undefined;
    try {
        const pending = Promise.resolve().then(() => { signal?.throwIfAborted(); return run(); });
        const value = await (cancelled ? Promise.race([pending, cancelled]) : pending); signal?.throwIfAborted(); return value;
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
}

// ───────── 存取 ─────────

export function loadMemes(path: string, log: (message: string) => void = () => undefined): MemeFile {
    const raw = readJsonOr<Partial<MemeFile>>(path, {}, message => log(`网络热梗：${message}`));
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).filter((e): e is MemeEntry => Boolean(e) && typeof e.term === 'string' && e.term.trim().length > 0
        && typeof e.meaning === 'string' && e.meaning.trim().length > 0 && typeof e.example === 'string' && (e.confidence === 'high' || e.confidence === 'mid')
        && typeof e.firstSeen === 'string' && typeof e.lastSeen === 'string' && typeof e.seen === 'number');
    return { version: 1, ...(typeof raw.refreshedAt === 'string' ? { refreshedAt: raw.refreshedAt } : {}), entries };
}

/** 存盘；目录不存在先建（writeJsonAtomic 不建目录——上线第一次存 memes/memes.json 就因为这个失败过） */
export function saveMemes(path: string, file: MemeFile): void {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, file);
}
export const memesPath = (dataDir: string): string => join(dataDir, 'memes', 'memes.json');

/** 过期（MEME_KEEP_DAYS 天没再出现）的去掉，最多留 MEME_MAX 个（最近出现的优先） */
export function trimMemes(entries: readonly MemeEntry[], now: Date): MemeEntry[] {
    const today = dayNumber(dayText(now));
    return entries
        .filter(e => today - dayNumber(e.lastSeen) <= MEME_KEEP_DAYS)
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen)
        .slice(0, MEME_MAX);
}

// ───────── 热榜 ─────────

export interface MemeLists {
    popular: { title: string; tname: string }[];
    hot: string[];
    weibo: string[];
    baidu: string[];
}

export const emptyLists = (): MemeLists => ({ popular: [], hot: [], weibo: [], baidu: [] });

export function parsePopular(body: unknown): MemeLists['popular'] {
    const list = (body as { data?: { list?: unknown[] } } | undefined)?.data?.list;
    return (Array.isArray(list) ? list : []).flatMap(item => {
        const v = item as { title?: unknown; tname?: unknown };
        const title = clean(v.title);
        return title ? [{ title, tname: clean(v.tname) }] : [];
    });
}

export function parseBiliHot(body: unknown): string[] {
    const list = (body as { list?: unknown[] } | undefined)?.list;
    return (Array.isArray(list) ? list : []).map(item => clean((item as { show_name?: unknown }).show_name)).filter(Boolean);
}

export function parseWeibo(body: unknown): string[] {
    const list = (body as { data?: { realtime?: unknown[] } } | undefined)?.data?.realtime;
    return (Array.isArray(list) ? list : []).map(item => clean((item as { word?: unknown }).word)).filter(Boolean);
}

export function parseBaidu(body: unknown): string[] {
    const cards = (body as { data?: { cards?: { content?: unknown }[] } } | undefined)?.data?.cards;
    const first = cards?.[0]?.content;
    // 有的返回是 content: [{ content: [...] }]，有的直接是 content: [...]
    const items = Array.isArray(first) && first.length && Array.isArray((first[0] as { content?: unknown }).content) ? (first[0] as { content: unknown[] }).content : Array.isArray(first) ? first : [];
    return items.map(item => clean((item as { word?: unknown }).word)).filter(Boolean);
}

export type JsonFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 读四个公开榜；哪个读不了就空着，不影响别的（全空由调用方决定怎么办） */
export async function fetchLists(doFetch: JsonFetch, log: (message: string) => void = () => undefined, signal?: AbortSignal): Promise<MemeLists> {
    signal?.throwIfAborted();
    const lists = emptyLists();
    const get = async (url: string, extra: Record<string, string> = {}): Promise<unknown> => {
        const timeout = AbortSignal.timeout(15_000);
        const response = await memeRead(signal, () => doFetch(url, { headers: { 'user-agent': UA, ...extra }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
        if (!response.ok) throw new Error(`返回 ${response.status}`);
        return memeRead(signal, () => response.json());
    };
    const tries: [string, () => Promise<void>][] = [
        ['B 站热门', async () => { for (const pn of [1, 2, 3]) lists.popular.push(...parsePopular(await get(`https://api.bilibili.com/x/web-interface/popular?ps=20&pn=${pn}`))); }],
        ['B 站热搜', async () => { lists.hot = parseBiliHot(await get('https://s.search.bilibili.com/main/hotword')); }],
        ['微博热搜', async () => { lists.weibo = parseWeibo(await get('https://weibo.com/ajax/side/hotSearch', { referer: 'https://weibo.com/' })); }],
        ['百度热榜', async () => { lists.baidu = parseBaidu(await get('https://top.baidu.com/api/board?platform=wise&tab=realtime')); }],
    ];
    for (const [name, run] of tries) {
        try { await run(); signal?.throwIfAborted(); } catch (error) { signal?.throwIfAborted(); log(`网络热梗：读${name}失败（${error instanceof Error ? error.message : String(error)}）`); }
    }
    signal?.throwIfAborted();
    return lists;
}

// ───────── 让模型挑词、写解释 ─────────

export function candidatePrompt(lists: MemeLists): string {
    const text = [
        lists.popular.length ? `B 站热门视频标题：\n${lists.popular.slice(0, 60).map(v => `- ${v.title}（${v.tname}）`).join('\n')}` : '',
        lists.hot.length ? `B 站热搜：${lists.hot.join(' | ')}` : '',
        lists.weibo.length ? `微博热搜：${lists.weibo.slice(0, 50).join(' | ')}` : '',
        lists.baidu.length ? `百度热榜：${lists.baidu.slice(0, 40).join(' | ')}` : '',
    ].filter(Boolean).join('\n');
    return `下面是今天几个榜单上的标题。请从里面挑出**可能是网络梗 / 流行语 / 圈内黑话**（年轻人会在聊天里拿来玩的词或短句）的，最多 ${MEME_CANDIDATES_MAX} 个。`
        + '不要：新闻、政治、灾害、案件、人名八卦、游戏版本号、广告、句式模板（带“X”的）、整句的视频标题。词要是一个具体的词或短句（2–12 个字），原样摘自标题。\n'
        + `每个输出一行 JSON：{"词":"...","来源":"哪个榜"}，不要别的字。\n\n${text}`;
}

/** 模型回复 → 候选词（去掉不合格的、重复的、敏感的） */
export function parseCandidates(reply: string): string[] {
    const out: string[] = [];
    for (const line of reply.split('\n')) {
        const match = /\{[\s\S]*\}/.exec(line);
        if (!match) continue;
        let term = '';
        try { term = clean((JSON.parse(match[0]) as { 词?: unknown })['词']); } catch { continue; }
        const length = chars(term);
        if (length < 2 || length > 12 || /[Xx×＊*]{1,}/.test(term) || /[「」“”"《》]/.test(term) || MEME_BLOCK.test(term) || BLOCKED.test(term) || out.includes(term)) continue;
        out.push(term);
        if (out.length >= MEME_CANDIDATES_MAX) break;
    }
    return out;
}

export function explainPrompt(term: string, evidence: readonly string[]): string {
    return `词：「${term}」\n下面是 B 站上和这个词有关的视频标题、简介、字幕和热评（可能和这个词无关）：\n${evidence.map(e => `- ${e}`).join('\n')}\n\n`
        + '请只根据上面的文字，判断这是不是一个网络梗 / 流行语，并输出一行 JSON：'
        + '{"是梗":true/false,"意思":"一句话，说它是什么意思、通常在什么情形下用（不超过 40 字）","例句":"一个像聊天里随口说的例句（不超过 20 字）",'
        + '"来历":"它从哪来的：哪个事件/哪句话被反复用起来的（不超过 40 字，文字里没有出处就留空）",'
        + '"为什么好笑":"它拧的是哪个预期、凭什么好笑（不超过 40 字，说不出就别编，留空）",'
        + '"什么时候用":"在谁之间、什么情绪、多熟的关系下用才合适（不超过 30 字）",'
        + '"什么时候别用":"**失效条件**：什么场合/对什么人用它就错了、会尴尬或冒犯（不超过 30 字；想不出来也要写，比如"他认真说事的时候"）",'
        + '"把握":"高/中/低（文字里有直接解释才算高；只能猜就是低）","适合聊天":true/false（政治、灾难、案件、低俗、地域或性别攻击、对人的贬称、广告 = false）}。'
        + '文字里看不出意思就写 {"是梗":false}。不要别的字。';
}

/** 模型回复 → 一条梗（不含出现日期）；不合格返回 undefined。规则在代码里：把握必须中 / 高、适合聊天必须 true */
export function parseExplain(term: string, reply: string): Pick<MemeEntry, 'term' | 'meaning' | 'example' | 'confidence' | 'origin' | 'why' | 'when' | 'avoid'> | undefined {
    const match = /\{[\s\S]*\}/.exec(reply);
    if (!match) return undefined;
    let o: Record<string, unknown>;
    try { o = JSON.parse(match[0]) as Record<string, unknown>; } catch { return undefined; }
    if (o['是梗'] !== true && o['是梗'] !== 'true') return undefined;
    const confidence = o['把握'] === '高' ? 'high' : o['把握'] === '中' ? 'mid' : undefined;
    if (!confidence) return undefined;
    if (o['适合聊天'] !== true && o['适合聊天'] !== 'true') return undefined;
    const meaning = clean(o['意思']);
    const example = clean(o['例句']);
    if (chars(meaning) < 6 || chars(meaning) > 60 || chars(example) > 24) return undefined;
    if (MEME_BLOCK.test(meaning) || MEME_BLOCK.test(example) || BLOCKED.test(meaning)) return undefined;
    // 来历 / 笑点 / 场合 / 失效条件：能解释清楚才收（2026-10-29 用户：她要理解为什么有这个梗、什么时候不该用）
    const origin = clean(o['来历']);
    const why = clean(o['为什么好笑']);
    const when = clean(o['什么时候用']);
    const avoid = clean(o['什么时候别用']);
    if (chars(why) < 6 || chars(why) > 60) return undefined;
    if (MEME_BLOCK.test(why) || MEME_BLOCK.test(avoid) || BLOCKED.test(why) || BLOCKED.test(avoid)) return undefined;
    const clip = (text: string, max: number) => (chars(text) <= max ? text : [...text].slice(0, max).join(''));
    return {
        term, meaning, example, confidence,
        ...(chars(origin) >= 4 ? { origin: clip(origin, 40) } : {}),
        why: clip(why, 40),
        ...(chars(when) >= 4 ? { when: clip(when, 30) } : {}),
        ...(chars(avoid) >= 4 ? { avoid: clip(avoid, 30) } : {}),
    };
}

// ───────── 找证据（她自己的 B 站号）─────────

export interface EvidenceDeps {
    search(keyword: string): Promise<BiliVideo[]>;
    subtitle(video: BiliVideo): Promise<SubtitleResult>;
    hotComments(aid: number): Promise<string[]>;
    sleep(ms: number): Promise<void>;
    signal?: AbortSignal;
}

const EXPLAINER = /梗|什么意思|是什么|含义|科普|出处|来源|解释/;
export const EVIDENCE_VIDEOS = 3;
export const EVIDENCE_GAP_MS = 1_000;

/** 搜「<词> 什么梗」：标题带这个词、又像在解释的视频排前面；读它们的字幕（前 360 字）、简介、热评。每个词最多 3 条证据 */
export async function gatherEvidence(term: string, deps: EvidenceDeps): Promise<string[]> {
    const signal = deps.signal;
    const found = await memeRead(signal, () => deps.search(`${term} 什么梗`));
    const core = term.replace(/[^一-龥A-Za-z0-9]/g, '').slice(0, 4);
    const score = (video: BiliVideo) => Number(video.title.includes(core)) * 2 + Number(EXPLAINER.test(video.title));
    const videos = [...found].sort((a, b) => score(b) - score(a)).slice(0, EVIDENCE_VIDEOS);
    const evidence: string[] = [];
    for (const video of videos) {
        await memeRead(signal, () => deps.sleep(EVIDENCE_GAP_MS));
        let subtitle = '';
        try { const result = await memeRead(signal, () => deps.subtitle(video)); if (result.status === 'ok') subtitle = subtitleExcerpt(result.lines, 360); } catch { signal?.throwIfAborted(); /* 读不到字幕就只用别的 */ }
        let comments: string[] = [];
        try { comments = await memeRead(signal, () => deps.hotComments(video.aid)); } catch { signal?.throwIfAborted(); /* 同上 */ }
        evidence.push(`视频《${video.title}》${video.desc ? `简介：${video.desc.slice(0, 100)}` : ''}${subtitle ? `；字幕：${subtitle}` : ''}${comments.length ? `；热评：${comments.map(c => c.slice(0, 50)).join(' / ')}` : ''}`);
    }
    signal?.throwIfAborted();
    return evidence;
}

// ───────── 刷新 ─────────

export interface RefreshDeps {
    path: string;
    now: () => Date;
    log: (message: string) => void;
    fetchLists(): Promise<MemeLists>;
    /** 后台模型调用（和小梗抽取一样走 purpose: 'background'） */
    ask(prompt: string): Promise<string>;
    gather(term: string): Promise<string[]>;
    signal?: AbortSignal;
}

export interface RefreshResult { added: number; bumped: number; tried: number; skipped?: string }

/** 刷新一次：读榜 → 挑词 → 新词找证据写解释 → 老词记一笔“又出现了” → 过期、截断、存盘。失败都只记日志，不抛 */
export async function refreshMemes(deps: RefreshDeps): Promise<RefreshResult> {
    const signal = deps.signal;
    try {
    signal?.throwIfAborted();
    const now = deps.now();
    signal?.throwIfAborted();
    const today = dayText(now);
    signal?.throwIfAborted();
    const file = loadMemes(deps.path, deps.log);
    signal?.throwIfAborted();
    let entries = [...file.entries];
    const lists = await memeRead(signal, () => deps.fetchLists());
    const total = lists.popular.length + lists.hot.length + lists.weibo.length + lists.baidu.length;
    if (!total) { deps.log('网络热梗：四个榜都没读到，这一轮不动'); return { added: 0, bumped: 0, tried: 0, skipped: '没读到榜' }; }
    let terms: string[];
    try { const prompt = candidatePrompt(lists); terms = parseCandidates(await memeRead(signal, () => deps.ask(prompt))); } catch (error) {
        signal?.throwIfAborted();
        deps.log(`网络热梗：挑词失败（${error instanceof Error ? error.message : String(error)}）`);
        return { added: 0, bumped: 0, tried: 0, skipped: '挑词失败' };
    }
    let bumped = 0;
    let added = 0;
    let tried = 0;
    for (const term of terms) {
        const known = entries.find(e => e.term === term);
        if (known) { known.lastSeen = today; known.seen++; bumped++; continue; }
        if (tried >= MEME_EXPLAIN_PER_RUN) continue;
        tried++;
        try {
            const evidence = await memeRead(signal, () => deps.gather(term));
            if (!evidence.length) continue;
            const prompt = explainPrompt(term, evidence);
            const explained = parseExplain(term, await memeRead(signal, () => deps.ask(prompt)));
            if (!explained) continue;
            entries.push({ ...explained, firstSeen: today, lastSeen: today, seen: 1 });
            added++;
        } catch (error) {
            signal?.throwIfAborted();
            deps.log(`网络热梗：「${term}」没弄成（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    entries = trimMemes(entries, now);
    const next: MemeFile = { version: 1, refreshedAt: now.toISOString(), entries };
    signal?.throwIfAborted();
    saveMemes(deps.path, next);
    const message = `网络热梗：榜上挑出 ${terms.length} 个词，新学会 ${added} 个、老的又出现 ${bumped} 个，现在共 ${entries.length} 个`;
    if (!signal?.aborted) deps.log(message);
    return { added, bumped, tried };
    } catch (error) { if (signal?.aborted) return { added: 0, bumped: 0, tried: 0, skipped: 'cancelled' }; throw error; }
}

/** 离上次刷新够久了（或从没刷过）就该刷 */
export function refreshDue(file: MemeFile, now: Date): boolean {
    return !file.refreshedAt || now.getTime() - Date.parse(file.refreshedAt) >= MEME_REFRESH_MS;
}

// ───────── 放进提示词 ─────────

type Said = { role: 'user' | 'assistant'; content: string; time?: string };

/** 他这一句里用到的库里的梗（最长的词优先；他这一串、她上一次回复以后说的） */
export function memeUsed(entries: readonly MemeEntry[], history: readonly Said[]): MemeEntry | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const text = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    return [...entries].sort((a, b) => chars(b.term) - chars(a.term)).find(e => text.includes(e.term));
}

const usedByHer = (entry: MemeEntry, history: readonly Said[], now: number) =>
    history.some(message => message.role === 'assistant' && message.content.includes(entry.term) && (message.time === undefined || now - Date.parse(message.time) < MEME_COOLDOWN_MS));

/**
 * 这一轮给她的梗：他用到了库里的梗就说意思让她接；没用到，约 MEME_TURN_SHARE 的轮次给她 3 个最近的（她最近说过的不再放）。没有就 undefined。
 * 调用方负责这些让路：他难过 / 生病 / 危机 / 小别扭 / 她在想事情 / 主动找他
 */
/** 当梗用不起来的词：查询残留、人名产品名、新闻、通用词（2026-10-29：库里 14 个，她一条都没用过） */
const NOT_A_MEME = /梗|iphone|苹果|华为|小米|型号|发哥|主播|UP主|热搜|新闻|通报|大对账|辣卤|太平洋/i;
const GENERIC = new Set(['代码', '游戏', '视频', '直播', '表情', '表情包', '音乐', '电影']);

/** 这个能不能当聊天里的梗用：短、不像新闻、不像人名产品、不是通用词 */
export function isUsableMeme(term: string): boolean {
    const text = term.trim();
    if (!text || [...text].length > 10) return false;
    if (NOT_A_MEME.test(text) || GENERIC.has(text)) return false;
    return true;
}

export function memeLine(entries: readonly MemeEntry[], history: readonly Said[], now: number): string | undefined {
    if (!entries.length) return undefined;
    const used = memeUsed(entries, history);
    if (used) {
        return `[他这一句里用了个网上的梗「${used.term}」：${used.meaning}${used.why ? `（为什么好笑：${used.why}）` : ''}。你大概知道这个梗，别说「没听懂」；顺着他的意思接，别解释梗、别拆梗，也别原样重复他的话]`;
    }
    const lastUser = history.findLast(message => message.role === 'user');
    if (!lastUser || unit(`${lastUser.time ?? ''} ${lastUser.content} meme`) >= MEME_TURN_SHARE) return undefined;
    const today = dayNumber(dayText(new Date(now)));
    const fresh = entries.filter(e => isUsableMeme(e.term) && e.why && e.avoid && today - dayNumber(e.lastSeen) <= MEME_FRESH_DAYS && !usedByHer(e, history, now))
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen);
    if (!fresh.length) return undefined;
    // 前 6 个里按这一句取 3 个，每次不都是同样的三个
    const pool = fresh.slice(0, 6);
    const picks = [...pool].sort((a, b) => unit(`${lastUser.content} ${a.term}`) - unit(`${lastUser.content} ${b.term}`)).slice(0, 3);
    const described = picks.map(e => `「${e.term}」${e.meaning}${e.why ? `；为什么好笑：${e.why}` : ''}${e.when ? `；什么时候合适：${e.when}` : ''}${e.avoid ? `；什么时候别用：${e.avoid}` : ''}`);
    return `[你最近在网上刷到的几个流行梗：${described.join('｜')}。这一轮先判断这场合合不合用——合适就在一句话里带出来（不解释、不点破、不加引号），**不合适就别用**，宁可不用也别硬塞；他难过或认真说事的时候一律不用]`;
}
