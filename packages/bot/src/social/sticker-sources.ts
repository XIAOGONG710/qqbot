// 表情包候选来源（ADR 0063 第二阶段「她自己攒表情包」）：
// bqb：开源仓库 ChineseBQB 的公开目录（zhaoolee.com/ChineseBQB，5871 张、114 个类别，按目录里的地址取图）。
// 不登录、不抓网页、没有反爬；它不是官方接口，也没有许可证文件，所以图只在本机自用、不进仓库、不外传。
// 谁能进来由两道代码闸门定，不靠看图判断器：
//   1. 只收 allow 里列出的类别（默认是 10-12 试跑过的 15 类动物 / 可爱 / 日常小人）；
//   2. 类别名里有时政、疫情这类词一律不要，即使有人把它加进 allow。
// 10-12 的试跑里判断器只看图片描述，一张带刀的卡通脸（来自「反港独」类）被收下，所以类别必须在代码里拦，不能指望判断器。
// 返回的是一个按天固定的候选池（同一天重启不会重新洗牌），收藏库自己去掉已经看过的并只取每天的几个。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '.././json-file.ts';

export const BQB_BASE = 'https://zhaoolee.com/ChineseBQB/';
export const BQB_DEFAULT_ALLOW: readonly string[] = [
    // 10-12 17:40 试跑的 15 类
    '可爱的女孩纸', '是喵星人啦', '开心鸭', '沙雕企鹅', '小幺鸡', '狗', '鸽子', '猪', '鹦鹉',
    '沙雕情侣头像', '白色小人', '滑稽大佬', '全是心心', '斗图之王', '乌龟',
    // 10-12 18:40 DSH 判完剩下的类别（allow-candidates.md）后，我又在真图上试跑、挑出能直接聊天用的 13 类；
    // 没收：可爱男孩纸 / TATAN（陌生小孩的真人照片）、演奏 / 穿什么（没有字、意思散）、绿帽子（出轨梗）、程序员 / 火柴人 / 浏览器 / 中国春节（太窄或有季节性，以后再说）
    '打电话', '负鼠', '汪蛋', '表情符号', '吃', '微信拍一拍', '莲蓬头男孩', '喷雾', '熊本熊', 'Panda金馆长熊猫', '旅行青蛙', 'Mur猫', '仓鼠',
    // 10-12 用户说「在加一些符合当前时代的」：目录里编号最靠后（最近加的）、有现在还在用的梗的 5 类。DSH 按「影视动漫游戏版权角色」判了 deny，
    // 用户的要求本身就是要这类梗；只在本机自用，真人 / 时政 / R 级的（黄仁勋、黑袍纠察队）仍不收。
    '企鹅家族', '人工智能', '黑神话悟空', '芙莉莲', '葫芦兄弟',
    // 10-12 晚用户裁定：「动漫、游戏、影视的版权角色，只要是符合的表情包都可以收」。把 DSH 因版权角色判 deny 的类别逐个在真图上试跑（每类 3 张），
    // 收的是判断器大多愿意留的；没收：马克丁 / 不良人（3 张全不收）、超级英雄们 / 夏洛特烦恼王老师 / 让子弹飞（3 张只留 1 张，台词长、有时政味或真人）、
    // 北方栖姬（400 张同一个角色，口吻常带性暗示）、假笑男孩 / 土嗨 / Moe可爱萝莉（真人小孩照片或太少）。真人名人、时政、疫情仍然不收。
    '胖虎', '小猪佩奇', '同福客栈', '苏大强', '天线宝宝', '猫和老鼠', '皮卡丘', '奥特曼', '魔仙王子游乐', '海绵宝宝', '猫咪日常', '杰尼龟',
    '猫眼三姐妹', '哆啦A梦', '柯南', 'Aqua阿库娅', 'JOJO的奇妙冒险', '辉夜大小姐', '虚拟youtuber', '鬼灭之刃', '进击的巨人', '刺客伍六七',
    '美少女战士', '原神', '间谍过家家', '女神异闻录', '电锯人', '老友记', '甄嬛传', '黑袍纠察队',
];
/** 第二道闸门：加进 allow 也不要的类别 */
const BQB_DENY = /特朗普|港独|反.{0,2}独|冠状|病毒|国庆|亮剑|觉醒年代|抬棺|马保国/;
const MAX_BYTES = 2_000_000;
const MIN_SIDE = 60;
const CACHE_VERSION = 1;

export interface BqbItem { src: string; category: string; animated: boolean; bytes: number }
/** allowKey：存的是按当时的名单过滤过的项，名单一变缓存就作废 */
interface BqbCache { version: typeof CACHE_VERSION; fetchedAt: number; allowKey: string; items: BqbItem[]; /** 目录里所有类别名（含没收的），用来发现维护者新加的类别 */ categories?: string[] }

export interface BqbOptions {
    /** 缓存目录（目录副本只存过滤后的几百到几千项，不到 1 MB） */
    dir: string;
    allow?: readonly string[];
    /** 每次返回多少个候选（收藏库会再去重、只取当天的几个） */
    pool?: number;
    /** 目录缓存多久重新取一次 */
    maxAgeMs?: number;
    fetchJson?: (url: string) => Promise<unknown>;
    now?: () => Date;
    log: (message: string) => void;
}

const plain = (title: string) => title.replace(/[^\p{L}\p{N}]/gu, '');

async function defaultFetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`目录返回 ${response.status}`);
    return response.json();
}

/** 目录里的一项是不是我们能用的：类别在名单内、不在黑名单，大小合适 */
export function acceptBqbItem(raw: unknown, allow: readonly string[]): BqbItem | undefined {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const title = typeof r.categoryTitle === 'string' ? r.categoryTitle : '';
    const src = typeof r.src === 'string' ? r.src : '';
    const bytes = typeof r.bytes === 'number' ? r.bytes : 0;
    if (!title || !/^media\/[\w.-]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(src)) return;
    if (BQB_DENY.test(title)) return;
    const name = plain(title);
    if (!allow.some(entry => name.startsWith(plain(entry)))) return;
    if (!bytes || bytes > MAX_BYTES) return;
    if (Number(r.width) < MIN_SIDE || Number(r.height) < MIN_SIDE) return;
    return { src, category: name, animated: r.animated === true, bytes };
}

function seeded(text: string): () => number {
    let h = 2166136261;
    for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
    return () => {
        h = (h + 0x6d2b79f5) | 0;
        let t = Math.imul(h ^ (h >>> 15), 1 | h);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
}

/** 当天固定的候选池：类别轮流取，免得「白色小人」这种 800 张的大类把别的挤掉 */
export function bqbPool(items: readonly BqbItem[], day: string, pool: number): string[] {
    const rand = seeded(`bqb:${day}`);
    const groups = new Map<string, BqbItem[]>();
    for (const item of items) groups.set(item.category, [...(groups.get(item.category) ?? []), item]);
    const lists = shuffled([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)), rand).map(([, list]) => shuffled(list, rand));
    const urls: string[] = [];
    for (let round = 0; urls.length < pool && lists.some(list => round < list.length); round++) {
        for (const list of lists) if (round < list.length && urls.length < pool) urls.push(BQB_BASE + list[round]!.src);
    }
    return urls;
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 给收藏库的 discover：返回当天的候选图地址 */
export function bqbDiscover(options: BqbOptions): () => Promise<string[]> {
    const allow = options.allow ?? BQB_DEFAULT_ALLOW;
    const now = options.now ?? (() => new Date());
    const maxAge = options.maxAgeMs ?? 7 * 86_400_000;
    const fetchJson = options.fetchJson ?? defaultFetchJson;
    const cachePath = join(options.dir, 'bqb-catalog.json');
    return async () => {
        mkdirSync(options.dir, { recursive: true });
        let cache = readJsonOr<BqbCache | undefined>(cachePath, undefined, options.log);
        const allowKey = allow.join('|');
        const fresh = cache && cache.version === CACHE_VERSION && cache.allowKey === allowKey && now().getTime() - cache.fetchedAt < maxAge;
        if (!fresh) {
            try {
                const raw = await fetchJson(`${BQB_BASE}catalog/search.json`);
                if (!Array.isArray(raw)) throw new Error('目录格式不对');
                const items = raw.map(item => acceptBqbItem(item, allow)).filter((item): item is BqbItem => !!item);
                if (!items.length) throw new Error('目录里没有符合名单的图');
                const categories = [...new Set(raw.map(item => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).categoryTitle === 'string' ? plain((item as Record<string, string>).categoryTitle!) : '')).filter(Boolean))].sort();
                const added = cache?.categories ? categories.filter(name => !cache!.categories!.includes(name)) : [];
                cache = { version: CACHE_VERSION, fetchedAt: now().getTime(), allowKey, items, categories };
                writeJsonAtomic(cachePath, cache);
                options.log(`表情来源 bqb：目录更新，${items.length} 张可用`);
                // 维护者加了新类别（热门的新梗常常是新类别）：不自动收，只记一行，等人看过再进名单
                if (added.length) options.log(`表情来源 bqb：目录里出现新类别（没在名单内，不会收）：${added.join('、')}`);
            } catch (error) {
                if (!cache?.items?.length) throw error;
                options.log(`表情来源 bqb：目录更新失败（${error instanceof Error ? error.message : String(error)}），继续用旧缓存`);
            }
        }
        // 缓存里的项在读出时再过一遍闸门：名单收紧、黑名单加词都立刻生效，不用等缓存过期
        const items = cache!.items.filter(item => acceptBqbItem({ ...item, categoryTitle: item.category, width: MIN_SIDE, height: MIN_SIDE }, allow));
        return bqbPool(items, localDay(now()), options.pool ?? 40);
    };
}
