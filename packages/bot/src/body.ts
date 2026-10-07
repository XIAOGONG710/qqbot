// 她的身体（ADR 0025）：卡上的 extensions.qqbot.world.body（source/world.yml 按档位裁剪）→ 某一刻她身上的事实。
// - 困、累、饿按作息推：早八那天两点睡七点四十起，上午困；过了零点半困了；课多的日子晚上累；饭点前饿，有的晚上饿了想吃夜宵。
// - 生理期按周期推（每个周期的长短按哈希在范围里取），头一两天可能痛经；细节只给 detail 的档位（男朋友、闺蜜、女生朋友），别的档位那几天只说身上不太舒服。
// - 小感冒按概率，几天里从嗓子疼到快好了。
// - 和世界一样按「日期 + 名目」取哈希，同一天对所有人一样，不存状态。进提示词的只有事实和一句约束（describeBody），不写台词。

import { classesOn, formatDate, herDay, wakeTime, type Schedule } from './schedule.ts';

export interface Body {
    period?: { first: string; cycle: [number, number]; days: number; crampsChance: number; detail: boolean };
    cold?: { perMonth: number; days: number };
}

export interface BodyNow {
    /** 生理期第几天；cramps：今天肚子疼（bad 疼得厉害、mild 隐隐的）；detail：这一档说得出口 */
    period?: { day: number; cramps?: 'bad' | 'mild'; detail: boolean };
    /** 感冒第几天（共几天） */
    cold?: { day: number; of: number };
    /** morning：早八那天上午；late：过了零点半 */
    sleepy?: { when: 'morning'; slept: string; woke: string } | { when: 'late' };
    /** 课多的日子，晚上 */
    tired?: boolean;
    hungry?: 'lunch' | 'dinner' | 'night';
}

const DAY_MS = 86_400_000;
/** 往回找周期起点最多找几个周期 */
const MAX_CYCLES = 400;
/** 一天课的分钟数到这么多算课多 */
const BUSY_MINUTES = 270;

/** 某一刻她身上的事实（同一天对所有人一样；档位只决定看得到哪些、生理期说不说得出口） */
export function bodyAt(body: Body, schedule: Schedule, now: Date): BodyNow {
    const day = herDay(schedule, now);
    const result: BodyNow = {};
    if (body.period) {
        const period = periodOn(body.period, day);
        if (period) result.period = period;
    }
    if (body.cold) {
        const cold = coldOn(body.cold, day);
        if (cold) result.cold = cold;
    }
    const { lessons } = classesOn(schedule, day);
    const minutesOfDay = now.getHours() * 60 + now.getMinutes();
    const woke = wakeTime(schedule, day, lessons);
    const early = woke.getHours() * 60 + woke.getMinutes() === toMinutes(schedule.wake.early);
    // 她的一天到 02:00 才结束：零点以后的「现在」在日历上是第二天
    const afterMidnight = now.getTime() - day.getTime() >= DAY_MS;
    if (afterMidnight) {
        if (minutesOfDay >= 30) result.sleepy = { when: 'late' };
    } else if (early && now >= woke && minutesOfDay < 12 * 60) {
        result.sleepy = { when: 'morning', slept: schedule.sleep, woke: schedule.wake.early };
    }
    const classMinutes = lessons.reduce((sum, lesson) => sum + (lesson.end.getTime() - lesson.start.getTime()) / 60_000, 0);
    if (classMinutes >= BUSY_MINUTES && !afterMidnight && minutesOfDay >= 18 * 60) result.tired = true;
    if (!afterMidnight && minutesOfDay >= 11 * 60 + 20 && minutesOfDay < 12 * 60) result.hungry = 'lunch';
    else if (!afterMidnight && minutesOfDay >= 17 * 60 + 10 && minutesOfDay < 17 * 60 + 50) result.hungry = 'dinner';
    else if ((afterMidnight || minutesOfDay >= 23 * 60 + 30) && unit(`${formatDate(day)} night snack`) < 0.3) result.hungry = 'night';
    return result;
}

/** 身上不舒服（痛经、感冒）：表达层不加「话多一点」（ADR 0024） */
export function unwell(now: BodyNow): boolean {
    return Boolean(now.period?.cramps || now.cold);
}

/** 时间块里的一行：只有事实和一句约束；没有就不放 */
export function describeBody(now: BodyNow): string | undefined {
    const parts: string[] = [];
    if (now.period) {
        const { day, cramps, detail } = now.period;
        if (detail) {
            parts.push(`生理期第 ${day} 天${cramps === 'bad' ? '，肚子疼得厉害，只想躺着' : cramps === 'mild' ? '，肚子隐隐地疼，懒得动' : ''}`);
        } else if (cramps) {
            parts.push(cramps === 'bad' ? '身上不太舒服，只想躺着' : '身上有点不舒服，懒得动');
        }
    }
    if (now.cold) {
        const { day, of } = now.cold;
        parts.push(day === 1 ? '有点感冒，嗓子疼' : day < of ? `感冒第 ${day} 天，鼻塞，说话闷闷的` : '感冒快好了，还有点咳');
    }
    if (now.sleepy?.when === 'morning') parts.push(`昨晚 ${now.sleepy.slept.replace(/^0/, '')} 睡、今早 ${now.sleepy.woke.replace(/^0/, '')} 起的，上午困`);
    if (now.sleepy?.when === 'late') parts.push('过了零点半，有点困了');
    if (now.tired) parts.push('今天课多，这会儿有点累');
    if (now.hungry === 'lunch' || now.hungry === 'dinner') parts.push('快到饭点了，有点饿');
    if (now.hungry === 'night') parts.push('这会儿有点饿，想吃点夜宵');
    if (!parts.length) return undefined;
    return `[你的身体（事实，影响你说话的劲头和能做的事；不用特意说，他问起或者话赶到了再说，说了就前后一致——不舒服就不会同时疯玩）：${parts.join('｜')}]`;
}

/** 今天是不是生理期、第几天、疼不疼 */
function periodOn(period: NonNullable<Body['period']>, day: Date): BodyNow['period'] | undefined {
    const start = cycleStart(period, day);
    if (!start) return undefined;
    const index = Math.round((day.getTime() - start.getTime()) / DAY_MS) + 1;
    if (index > period.days) return undefined;
    const cramps = unit(`${formatDate(start)} cramps`) < period.crampsChance;
    return { day: index, ...(cramps && index === 1 ? { cramps: 'bad' as const } : cramps && index === 2 ? { cramps: 'mild' as const } : {}), detail: period.detail };
}

/** 包含 day 的那个周期从哪天开始（first 之前没有） */
function cycleStart(period: NonNullable<Body['period']>, day: Date): Date | undefined {
    let start = parseDate(period.first);
    if (day < start) return undefined;
    for (let k = 0; k < MAX_CYCLES; k++) {
        const [min, max] = period.cycle;
        const length = min + Math.floor(unit(`${formatDate(start)} cycle`) * (max - min + 1));
        const next = addDays(start, length);
        if (day < next) return start;
        start = next;
    }
    return undefined;
}

/** 今天是不是在感冒（某天开始，按概率；持续 days 天），第几天 */
function coldOn(cold: NonNullable<Body['cold']>, day: Date): BodyNow['cold'] | undefined {
    const chance = cold.perMonth / 30;
    for (let back = cold.days - 1; back >= 0; back--) {
        const start = addDays(day, -back);
        if (unit(`${formatDate(start)} cold`) < chance) return { day: back + 1, of: cold.days };
    }
    return undefined;
}

export function parseBody(value: unknown, fail: (what: string) => never): Body | undefined {
    if (value === undefined || value === null) return undefined;
    const body = value as Body;
    if (body.period) {
        const p = body.period;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.first) || !Array.isArray(p.cycle) || p.cycle.length !== 2 || !(p.days >= 1) || typeof p.crampsChance !== 'number' || typeof p.detail !== 'boolean') {
            fail('.body.period 格式不对');
        }
    }
    if (body.cold && !(body.cold.perMonth >= 0 && body.cold.days >= 1)) fail('.body.cold 格式不对');
    return body;
}

function unit(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x1_0000_0000;
}

function toMinutes(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h! * 60 + m!;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function parseDate(text: string): Date {
    const [y, m, d] = text.split('-').map(Number);
    return new Date(y!, m! - 1, d);
}
