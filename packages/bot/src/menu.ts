// 她每顿吃什么（ADR 0125，配置 menu，默认关）。
// 为什么：账上的“吃饭”只有午饭 / 晚饭、在食堂还是外卖还是在家、几点——没有“吃了什么”。他问“中午吃的啥”，她就现编一个（“食堂的黄焖鸡”）：
// 今天说黄焖鸡、明天又说黄焖鸡，前后对不上，更没法让“吃的照片”和她说的那一顿对得上。
// 用户 10-23 裁决：「菜单每天随机」。做法：每天每顿从一张菜单里按日期取一道，同一天对所有人一样，重启、重放都一样（和作息、小事一个办法）；
// 不存状态——菜是日期的函数。一个循环里不重样（按日期分块洗牌，块与块交界处也不连着重样）。
// 菜单是通用的学生日常（食堂、外卖、在家都说得过去），不写店名、不写谁做的饭——那是作者才定的事。想换菜单：世界书 routine.menu（或改这里的默认）。

import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { formatDate } from './schedule.ts';
import type { World } from './world.ts';

export type MealKind = 'lunch' | 'dinner';

export interface Menu {
    lunch: readonly string[];
    dinner: readonly string[];
}

/** 默认菜单：山东高校学生食堂 / 外卖 / 在家都常见的饭。每一道都得是一句话说得出口的菜名 */
export const DEFAULT_MENU: Menu = {
    lunch: [
        '黄焖鸡米饭', '把子肉饭', '番茄鸡蛋盖饭', '红烧肉盖饭', '兰州拉面', '酸辣粉', '鸡腿饭', '炒面', '麻辣香锅', '土豆牛腩饭',
        '宫保鸡丁盖饭', '酸菜鱼饭', '青椒肉丝盖饭', '炸酱面', '煲仔饭', '鱼香肉丝饭', '水饺', '小炒肉盖饭', '麻辣烫',
    ],
    dinner: [
        '炒饭', '砂锅米线', '小馄饨', '炒河粉', '水饺', '包子配小米粥', '牛肉面', '肉夹馍配凉皮', '麻辣烫', '番茄鸡蛋面',
        '黄焖鸡', '烧茄子盖饭', '小笼包', '酸汤水饺', '炒米粉', '干锅花菜饭', '刀削面', '菜包配豆浆', '煎饼卷大葱',
    ],
};

/** 0 ≤ x < 1，FNV-1a（和作息、心情的固定选法一致） */
function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x1_0000_0000;
}

const DAY_MS = 86_400_000;
/** 从 YYYY-MM-DD 取“第几天”（按日历日，不受夏令时 / 时区影响） */
function dayNumber(date: string): number {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 这一块（一个循环）的菜序：按“块号 + 这顿 + 菜名”取哈希排序，是一次洗牌 */
function blockOrder(block: number, kind: MealKind, dishes: readonly string[]): string[] {
    return [...dishes].sort((a, b) => unit(`${block} ${kind} ${a}`) - unit(`${block} ${kind} ${b}`) || a.localeCompare(b));
}

/**
 * 这一天这顿吃什么。菜单为空返回 undefined。
 * 一个循环（菜单有几道就几天）里每道只出现一次；块与块的交界：新一块的第一道如果和上一块最后一道一样，和第二道换一下，免得连着两天吃一样的。
 * （菜单只有两道时交界处的对调会动到上一块的最后一道，可能连着重样——两道的菜单本来就轮着吃，不管它。）
 */
export function dishOn(date: string, kind: MealKind, menu: Menu = DEFAULT_MENU): string | undefined {
    const dishes = [...new Set(menu[kind].map(dish => dish.trim()).filter(Boolean))];
    if (!dishes.length) return undefined;
    if (dishes.length === 1) return dishes[0];
    const n = dayNumber(date);
    const block = Math.floor(n / dishes.length);
    const order = blockOrder(block, kind, dishes);
    const previous = blockOrder(block - 1, kind, dishes);
    // 上一块洗牌之后的最后一道，如果是这一块的第一道，则这一块的第一、第二道对调
    if (order[0] === previous.at(-1)) [order[0], order[1]] = [order[1]!, order[0]!];
    return order[n - block * dishes.length];
}

/** 世界书里 routine.menu 写了就用它，没写用默认；写得不对（不是一串菜名）就用默认 */
export function menuOf(value: unknown): Menu {
    const pick = (key: MealKind) => {
        const list = (value as Record<string, unknown> | undefined)?.[key];
        const dishes = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
        return dishes.length ? dishes : DEFAULT_MENU[key];
    };
    return { lunch: pick('lunch'), dinner: pick('dinner') };
}

/**
 * 第一次开 menu 时定下“从哪天起”并存进文件，以后重启都读同一个（和 everyday-from.json 一个办法）：从第二天起，已经过完的日子不改——
 * 她以前随口说过什么就是什么，不会被新菜单改写。文件读不了就用今天之后的一天
 */
export function loadMenuFrom(path: string, now: Date, log: (message: string) => void = () => undefined): string {
    const existing = readJsonOr<{ version?: number; from?: string }>(path, {}, message => log(`吃什么：${message}`));
    if (existing.version === 1 && typeof existing.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(existing.from)) return existing.from;
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const from = formatDate(tomorrow);
    writeJsonAtomic(path, { version: 1, from });
    log(`吃什么：从 ${from} 起生效（已经过完的日子不改）`);
    return from;
}

/** 把菜单放进这个世界（世界书 routine.menu 写了就用它）；from：从这一天起才有 */
export function withMenu(world: World | undefined, from?: string): World | undefined {
    if (!world) return world;
    return { ...world, menu: menuOf((world.routine as { menu?: unknown } | undefined)?.menu), ...(from ? { menuFrom: from } : {}) };
}

/** 句子里说这顿的菜：「（吃的是黄焖鸡米饭）」；没有菜就是空 */
export function dishNote(dish: string | undefined): string {
    return dish ? `，吃的是${dish}` : '';
}
