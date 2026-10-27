// 她的钱（ADR 0035）：卡上的 extensions.qqbot.world.money（source/world.yml 按档位裁剪）。记账在 world.ts 的 simulateWorld 里一天天推：
// 每月 payday 号到账生活费；三餐（ADR 0031，食堂 / 外卖，在家不花）、带 cost 的小事（奶茶、米线）、网购的快递和猫粮按价钱花；偶尔接个线上单进账；
// 相机基金每周那天存「留够到下次到账每天 keepPerDay 以后剩下的」。价钱、哪天接单都按「日期 + 名目」取哈希，重放一样，不存状态。
// 不因为钱少就少吃少喝：persona.yml「生活费两千多，宽裕」「从不亏自己」——钱紧只体现在存得少。

import { formatDate } from './schedule.ts';

export interface Money {
    allowance: number;
    payday: number;
    start: number;
    /** 钱快花完、离到账还有几天时跟家里要多少（persona.yml「爸妈宠你」） */
    askHome: number;
    /** misc：在学校每天的零碎（零食饮料、日用品） */
    prices: { canteen: [number, number]; takeout: [number, number]; misc: [number, number]; catFood: number; parcels: Record<string, number> };
    sideJobs?: { perMonth: number; pay: [number, number]; kinds: string[] };
    saving: { keepPerDay: number; step: number; max: number };
    /** 这一档说得出口余额、花了多少（和 persona.yml family.money 一样只给男朋友、闺蜜） */
    detail: boolean;
}

/** 一笔账：花的、存进相机基金的是负数，进账是正数 */
export interface MoneyEntry {
    at: Date;
    amount: number;
    what: string;
    kind: 'spend' | 'income' | 'deposit';
}

/** 网购下单的时刻（那天中午） */
export const ORDER_TIME = '12:30';
/** 生活费到账的时刻 */
export const PAY_TIME = '08:00';
/** 跟家里要钱的时刻（那天晚上） */
export const ASK_HOME_TIME = '22:30';
/** 零碎记在下午 */
export const MISC_TIME = '16:00';
/** 网购的东西资料里没写价钱时 */
const DEFAULT_PRICE = 30;

/** 范围里按哈希取一个整数价钱 */
export function priceIn([min, max]: readonly [number, number], key: string): number {
    return min + Math.floor(unit(key) * (max - min + 1));
}

export function parcelPrice(money: Money, item: string, food: boolean): number {
    return food ? money.prices.catFood : money.prices.parcels[item] ?? DEFAULT_PRICE;
}

/** day 之后（不含 day）下一次到账是哪天 */
export function nextPayday(money: Money, day: Date): Date {
    const thisMonth = new Date(day.getFullYear(), day.getMonth(), money.payday);
    return thisMonth > day ? thisMonth : new Date(day.getFullYear(), day.getMonth() + 1, money.payday);
}

/** day 那天或之前最近一次到账是哪天 */
export function lastPayday(money: Money, day: Date): Date {
    const thisMonth = new Date(day.getFullYear(), day.getMonth(), money.payday);
    return thisMonth <= day ? thisMonth : new Date(day.getFullYear(), day.getMonth() - 1, money.payday);
}

/** 这天接没接线上单：按月排（平均每月 perMonth 个，整数部分一定有），哪天、什么活、多少钱按哈希 */
export function sideJobOn(money: Money, day: Date): { kind: string; pay: number } | undefined {
    const jobs = money.sideJobs;
    if (!jobs || !jobs.kinds.length) return undefined;
    const month = formatDate(day).slice(0, 7);
    const length = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    const count = Math.floor(jobs.perMonth) + (unit(`${month} side job extra`) < jobs.perMonth % 1 ? 1 : 0);
    for (let k = 0; k < count; k++) {
        if (1 + Math.floor(unit(`${month} side job ${k} day`) * length) !== day.getDate()) continue;
        return { kind: jobs.kinds[Math.floor(unit(`${month} side job ${k} kind`) * jobs.kinds.length)]!, pay: priceIn(jobs.pay, `${month} side job ${k} pay`) };
    }
    return undefined;
}

/** 这周存多少：手上的钱留够到下次到账前每天 keepPerDay，剩下的按 step 往下取整，最多 max，不超过离目标还差的 */
export function depositFor(money: Money, balance: number, day: Date, toGoal: number): number {
    const daysLeft = Math.round((nextPayday(money, day).getTime() - new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) / 86_400_000) - 1;
    const spare = balance - Math.max(0, daysLeft) * money.saving.keepPerDay;
    return Math.max(0, Math.min(money.saving.max, toGoal, Math.floor(spare / money.saving.step) * money.saving.step));
}

/** 「今天花了 46 元（午饭 15、奶茶 18、晚饭 13）」里括号的部分：同名的合在一起 */
export function spendItems(entries: readonly { what: string; amount: number }[]): string {
    const sums = new Map<string, number>();
    for (const e of entries) sums.set(e.what, (sums.get(e.what) ?? 0) + e.amount);
    return [...sums].map(([what, amount]) => `${what} ${amount}`).join('、');
}

/** FNV-1a 加 fmix32（同 npc.ts） */
function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 16;
    return (hash >>> 0) / 0x1_0000_0000;
}
