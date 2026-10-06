// 她认识的人（ADR 0016）：名单里的人互相认识。
// 他最后 3 条、或她最后 2 次回复里出现了名单里另一个人的称呼，而那个人写了「别人提起时」（intro），这一轮就放一段介绍；
// 开了长期记忆时，contact.ts 再从那个人自己的 bank 召回几条接在后面。陌生人档、名单外的人提起时不给。

import { UNLISTED_TIER, type Contact, type Tier } from './config.ts';
import type { StoredMessage } from './history.ts';
import { herDay, type Schedule } from './schedule.ts';

type Said = Pick<StoredMessage, 'role' | 'content'>;

/** 一次最多介绍几个人 */
export const MAX_MENTIONED = 2;

/** 称呼至少几个字才算：单字太容易出现在别的话里 */
const MIN_NAME_CHARS = 2;

/** 这两档提起别人时不给介绍和记忆，也不用公共记忆（ADR 0016 决策 2、3） */
export function knowsPeople(tier: Tier | string): boolean {
    return tier !== 'stranger' && tier !== UNLISTED_TIER;
}

/** 这几轮里提到的名单里的其他人（写了 intro 的），最近提到的在前，最多 MAX_MENTIONED 个 */
export function mentionedPeople(history: readonly Said[], self: Contact, contacts: readonly Contact[]): Contact[] {
    if (!knowsPeople(self.tier)) return [];
    const candidates = contacts.filter(c => c.qq !== self.qq && c.intro && [...c.name].length >= MIN_NAME_CHARS);
    if (candidates.length === 0) return [];

    // 窗口同 ADR 0015 判断「聊到书」：他最后 3 条、她最后 2 次回复（连着发的几条算一次）
    const his = history.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user').slice(-3)
        .map(item => ({ index: item.index, text: item.message.content }));
    const replies: { index: number; text: string }[] = [];
    let inReply = false;
    for (const [index, message] of history.entries()) {
        if (message.role === 'assistant') {
            if (inReply) {
                const last = replies.at(-1)!;
                last.text += `\n${message.content}`;
                last.index = index;
            } else {
                replies.push({ index, text: message.content });
            }
            inReply = true;
        } else {
            inReply = false;
        }
    }
    const recent = [...his, ...replies.slice(-2)].sort((a, b) => b.index - a.index);

    const found: Contact[] = [];
    for (const item of recent) {
        const hits = candidates
            .filter(c => !found.includes(c) && item.text.includes(c.name))
            .sort((a, b) => item.text.lastIndexOf(b.name) - item.text.lastIndexOf(a.name));
        for (const person of hits) {
            found.push(person);
            if (found.length === MAX_MENTIONED) return found;
        }
    }
    return found;
}

/** 线索是「问她过去的事」（commonCue 的返回值） */
export const ASKS_PAST = '问她过去的事';

// 问她过去的事（ADR 0017）：同一句里有时间和经历。ADR 0018 加了这周、假期和作息里假期的名字（「国庆过得怎样」）
const PAST_TIME = '今天|昨天|前天|昨晚|今早|今晚|早上|上午|中午|下午|晚上|周末|上周|上星期|上个星期|上礼拜|这周|这星期|这礼拜|本周|上个月|'
    + '上次|那天|那次|最近|这几天|前几天|刚才|之前|以前|假期|放假|寒假|暑假';
const PAST_DOING = /干嘛|干啥|干了|干什么|做什么|做啥|做了|去哪|去了|在忙|忙啥|忙什么|忙了|过得|怎么过|玩了|吃了|吃的|看了|上了|上的|学了|买了|见了|聊了|遇到|碰到|发生|怎么样/;

/** 时间词（加上假期的名字）和「接着问另一天」（「那前天呢」「你昨天呢？」「那国庆呢」，只有时间）；按假期名缓存 */
const pastPatterns = (() => {
    const cache = new Map<string, { time: RegExp; followUp: RegExp }>();
    return (holidays: readonly string[]) => {
        const key = holidays.join('|');
        let patterns = cache.get(key);
        if (!patterns) {
            const time = [PAST_TIME, ...holidays.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|');
            patterns = { time: new RegExp(time), followUp: new RegExp(`^(那|那你|你)?(${time})(呢|[?？])+$`) };
            cache.set(key, patterns);
        }
        return patterns;
    };
})();

/** 作息里假期的名字和简称（「国庆节」「国庆」），给「问她过去的事」当时间词（ADR 0018 决策 3） */
export function holidayWords(schedule: Schedule | undefined): string[] {
    const names = (schedule?.holidays ?? []).flatMap(h => [h.name, h.name.replace(/节$/, '')]);
    return [...new Set(names)].filter(name => [...name].length >= MIN_NAME_CHARS);
}

/**
 * 公共记忆的线索（ADR 0017，有线索才想起）：他这次的话（她上次回复之后的）里出现了公共库里的实体名，或者问她过去的事。
 * 返回线索（写日志用），没有就是 undefined。实体名至少 2 个字，不算她自己和他自己的名字；
 * 问过去的事要是问她的：有「你」、是问句，或者没说「我」（「我今天去爬山了」不算）
 */
export function commonCue(
    history: readonly Said[], self: Contact, entities: readonly string[], charName: string, holidays: readonly string[] = [],
): string | undefined {
    if (!knowsPeople(self.tier)) return undefined;
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content);
    if (said.length === 0) return undefined;
    const text = said.join('\n');
    const entity = entities
        .filter(name => [...name].length >= MIN_NAME_CHARS && name !== charName && name !== self.name && text.includes(name))
        .sort((a, b) => b.length - a.length)[0];
    if (entity) return entity;
    const { time, followUp } = pastPatterns(holidays);
    const asksHer = said.some(line => followUp.test(line.trim())
        || (time.test(line) && PAST_DOING.test(line) && (/你/.test(line) || /[?？吗呢]\s*$/.test(line) || !/我/.test(line))));
    return asksHer ? ASKS_PAST : undefined;
}

const DAY_WORDS: readonly [RegExp, number][] = [[/前天/, -2], [/昨天|昨晚/, -1], [/今天|今早|今晚|早上|上午|中午|下午|晚上|刚才/, 0]];
const FUTURE = /明天|后天|明早|明晚|待会|一会儿|下周|下星期|下个星期|下礼拜|下个月|下次|明年/;
const WEEK_WORDS: readonly [RegExp, number][] = [[/上周|上星期|上个星期|上礼拜|上个礼拜/, -1], [/这周|这星期|这个星期|这礼拜|本周/, 0]];
const LAST_MONTH = /上个月/;
const ANY_HOLIDAY = /假期|放假|寒假|暑假/;

/** 问的那段时间（ADR 0018 决策 3）；period：是一周、一个月、一个假期，不是某一天 */
export interface AskedWindow {
    start: Date;
    end: Date;
    period?: 'week' | 'month' | 'holiday';
}

/**
 * 问她过去的事时问的是哪一天（ADR 0017）：他这次的话里最后一句带「前天」「昨天」「今天下午」……的，返回那天的时间窗；
 * 「最近」「上次」不是某一天，返回 undefined。召回公共记忆时只留那天的，不然别的日子的日记会挤进来。
 * 有作息时按她的一天算（ADR 0018 决策 4）：凌晨 1 点问「今天」问的是刚过去的那天，时间窗到第二天她睡觉（02:00）
 */
export function askedDay(history: readonly Said[], now: Date, schedule?: Schedule): AskedWindow | undefined {
    return asked(history, now, schedule, false);
}

/**
 * 问她过去的事时问的是哪段时间：某一天（askedDay），或者（ADR 0018 决策 3）上周 / 这周（周一到周日）、上个月、
 * 作息里的某个假期（说了名字，或者只说「假期」「放假」就是最近开始的那个）。他这次的话里最后一句带时间的为准，将来的不算；
 * 时间窗的结束按她的一天算到第二天她睡觉
 */
export function askedWindow(history: readonly Said[], now: Date, schedule?: Schedule): AskedWindow | undefined {
    return asked(history, now, schedule, true);
}

function asked(history: readonly Said[], now: Date, schedule: Schedule | undefined, periods: boolean): AskedWindow | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const said = history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content);
    const today = schedule ? herDay(schedule, now) : now;
    const [h, m] = schedule ? schedule.sleep.split(':').map(Number) : [0, 0];
    const day = (date: Date, offset = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
    /** start 那天 0 点到 last 第二天她睡觉 */
    const span = (start: Date, last: Date, period?: AskedWindow['period']): AskedWindow => ({
        start: day(start), end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1, h, m), ...(period ? { period } : {}),
    });
    for (const line of said.toReversed()) {
        if (FUTURE.test(line)) continue;
        const offset = DAY_WORDS.find(([pattern]) => pattern.test(line))?.[1];
        if (offset !== undefined) return span(day(today, offset), day(today, offset));
        if (!periods) continue;
        const holidays = schedule?.holidays ?? [];
        const parse = (date: string) => { const [y, mo, d] = date.split('-').map(Number); return new Date(y!, mo! - 1, d); };
        const named = holidays.find(h => holidayWords({ ...schedule!, holidays: [h] }).some(name => line.includes(name)));
        const latest = ANY_HOLIDAY.test(line)
            ? holidays.filter(h => parse(h.start) <= today).sort((a, b) => b.start.localeCompare(a.start))[0]
            : undefined;
        const holiday = named ?? latest;
        if (holiday) return span(parse(holiday.start), parse(holiday.end), 'holiday');
        const week = WEEK_WORDS.find(([pattern]) => pattern.test(line))?.[1];
        if (week !== undefined) {
            const monday = day(today, -((today.getDay() + 6) % 7) + 7 * week);
            return span(monday, day(monday, 6), 'week');
        }
        if (LAST_MONTH.test(line)) {
            return span(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0), 'month');
        }
    }
    return undefined;
}

/** 刚想起来的公共记忆还记得多久（ADR 0017）：她之后回了几次以内、多久以内 */
export const COMMON_LINGER_REPLIES = 2;
export const COMMON_LINGER_MS = 10 * 60_000;

/**
 * 刚想起来的公共记忆这一轮还在不在脑子里：想起之后她回了 COMMON_LINGER_REPLIES 次以内（连发的几条算一次）、COMMON_LINGER_MS 以内。
 * 追问（「你不是不能吃辣吗」）本身没有线索，不沿用的话她会忘了刚说过的事
 */
export function stillInMind(chat: readonly { role: 'user' | 'assistant'; time?: string }[], recalledAt: number, now: number): boolean {
    if (now - recalledAt >= COMMON_LINGER_MS) return false;
    const replies = chat.filter((message, i) => message.role === 'assistant' && chat[i - 1]?.role !== 'assistant'
        && message.time !== undefined && Date.parse(message.time) >= recalledAt).length;
    return replies <= COMMON_LINGER_REPLIES;
}

/** 介绍一个人：称呼和 intro，后面接她对他的印象（ADR 0017）、召回到的记忆（都已整理成一段，没有的不写） */
export function describePerson(person: Contact, ...more: (string | undefined)[]): string {
    return [`[你认识的人：${person.name}]`, `${person.name}：${person.intro}`, ...more.filter(text => text)].join('\n');
}
