// 她自己的日子（ADR 0015）：每日心情和在读的书。这里都是纯函数；拼提示词、日志和配置开关在接线步骤做。

import type { StoredMessage } from './history.ts';
import { classesOn, formatDate, herDay, type Schedule } from './schedule.ts';

export const MOOD_DAYS = ['early', 'busy', 'no_class', 'holiday'] as const;
export type MoodDay = (typeof MOOD_DAYS)[number];

export interface DailyMood {
    name: string;
    weight: number;
    style: string;
    when: { day: MoodDay; factor: number; reason: string }[];
}

export interface ReadingBook {
    id: string;
    title: string;
    aliases: string[];
    author: string;
    kind: string;
    platform: string;
    status: string;
    total?: { amount: number; unit: string };
    progress: {
        startDay: string;
        start: number;
        everyDays: number;
        amount: number;
        unit: string;
        max?: number;
        state: 'reading' | 'put_down';
    };
    attitude: string;
    unreadKeywords: string[];
    nodes: { id: string; topic: string; from: number; keywords: string[]; points: string[] }[];
}

export interface MoodChoice {
    day: string;
    mood: DailyMood;
    reason: string;
    conditions: MoodDay[];
}

const DAY_MS = 86_400_000;
const FALLBACK_REASON = '说不上为什么，今天就是这样';

/** 这一天会怎样影响心情：早八、课多、学期中没课、放假。 */
export function moodDayConditions(schedule: Schedule, day: Date): MoodDay[] {
    const text = formatDate(day);
    const holiday = schedule.holidays.some(item => item.start <= text && text <= item.end);
    const { lessons, outsideSemester } = classesOn(schedule, day);
    const early = schedule.periods[schedule.wake.earlySlot];
    const conditions: MoodDay[] = [];
    if (early && lessons.some(lesson => lesson.start.getHours() === Number(early.start.slice(0, 2))
        && lesson.start.getMinutes() === Number(early.start.slice(3)))) conditions.push('early');
    if (lessons.length >= 3) conditions.push('busy');
    if (!holiday && !outsideSemester && lessons.length === 0) conditions.push('no_class');
    if (holiday) conditions.push('holiday');
    return conditions;
}

/** 日期 → 心情：同一天对所有人相同，按当天情况调权重，不存状态。 */
export function moodAt(schedule: Schedule, moods: readonly DailyMood[], now: Date): MoodChoice | undefined {
    if (!moods.length) return undefined;
    const day = herDay(schedule, now);
    const conditions = moodDayConditions(schedule, day);
    const weighted = moods.map(mood => {
        const matched = mood.when.filter(item => conditions.includes(item.day));
        return { mood, matched, weight: mood.weight * matched.reduce((value, item) => value * item.factor, 1) };
    });
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let point = (stableHash(`${formatDate(day)} mood`) / 0x1_0000_0000) * total;
    const selected = weighted.find(item => (point -= item.weight) < 0) ?? weighted.at(-1)!;
    // 同时命中早八和课多时，取资料里排在前面的那条；原因仍然是真的，不拼成一长串。
    return {
        day: formatDate(day), mood: selected.mood,
        reason: selected.matched[0]?.reason ?? FALLBACK_REASON,
        conditions,
    };
}

export interface BookProgress {
    amount: number;
    unit: string;
    /** 到可靠的全书总量才算读完；《药屋》第 10 卷只是停住，不叫读完 */
    finished: boolean;
    /** 设定为放下，或者读到进度上限 */
    stopped: boolean;
}

/** 某本书在她的某一天的进度。day 应是 herDay 算出的零点。 */
export function bookProgressOn(book: ReadingBook, day: Date): BookProgress {
    const start = parseDate(book.progress.startDay);
    const days = Math.max(0, calendarDays(start, day));
    const advanced = book.progress.state === 'put_down' ? 0 : Math.floor(days / book.progress.everyDays) * book.progress.amount;
    const raw = book.progress.start + advanced;
    const amount = book.progress.max === undefined ? raw : Math.min(raw, book.progress.max);
    const finished = book.total !== undefined && book.total.unit === book.progress.unit && amount >= book.total.amount;
    const stopped = book.progress.state === 'put_down' || (book.progress.max !== undefined && amount >= book.progress.max);
    return { amount, unit: book.progress.unit, finished, stopped };
}

export function bookProgressAt(schedule: Schedule, book: ReadingBook, now: Date): BookProgress {
    return bookProgressOn(book, herDay(schedule, now));
}

/** 只给已经读到的情节节点。 */
export function availableBookNodes(book: ReadingBook, progress: BookProgress): ReadingBook['nodes'] {
    return book.nodes.filter(node => node.from <= progress.amount);
}

/** 他这句话问到了还没读到、或资料明确不提供的内容。 */
export function unreadBookTopics(book: ReadingBook, progress: BookProgress, text: string): string[] {
    const normalized = text.toLowerCase();
    const topics = book.nodes
        .filter(node => node.from > progress.amount && node.keywords.some(keyword => normalized.includes(keyword.toLowerCase())))
        .map(node => node.topic);
    if (book.unreadKeywords.some(keyword => normalized.includes(keyword.toLowerCase()))) topics.push('资料里没有的后续');
    return [...new Set(topics)];
}

export interface BookMention {
    mentioned: boolean;
    /** 泛问「在看什么书」时是全部；点到某本书、作者或节点时只列命中的书 */
    bookIds: string[];
}

const BOOK_WORDS = /书|小说|在看什么|看什么书|看到哪|读到哪|追更/;

/** 最近：他的最后 3 条、她的最后 2 次回复。 */
export function bookMention(history: readonly StoredMessage[], books: readonly ReadingBook[]): BookMention {
    const his = history.filter(message => message.role === 'user').slice(-3).map(message => message.content);
    const replies: string[][] = [];
    let inReply = false;
    for (const message of history) {
        if (message.role === 'assistant') {
            if (!inReply) replies.push([]);
            replies.at(-1)!.push(message.content);
            inReply = true;
        } else {
            inReply = false;
        }
    }
    const texts = [...his, ...replies.slice(-2).flat()];
    const all = texts.join('\n').toLowerCase();
    const ids = books.filter(book => bookTerms(book).some(term => all.includes(term.toLowerCase()))).map(book => book.id);
    if (ids.length) return { mentioned: true, bookIds: ids };
    return BOOK_WORDS.test(all) ? { mentioned: true, bookIds: books.map(book => book.id) } : { mentioned: false, bookIds: [] };
}

/** 状态行的空闲活动是不是在看资料里的书。 */
export function readingActivity(text: string, books: readonly ReadingBook[]): boolean {
    return /看书|读书/.test(text) || books.some(book => [book.title, ...book.aliases].some(term => term && text.includes(term)));
}

function bookTerms(book: ReadingBook): string[] {
    return [book.title, ...book.aliases, book.author, ...book.unreadKeywords,
        ...book.nodes.flatMap(node => [...node.keywords, ...node.points])].filter(term => term.length >= 2);
}

function calendarDays(from: Date, to: Date): number {
    return Math.floor((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY_MS);
}

function parseDate(text: string): Date {
    const [year, month, day] = text.split('-').map(Number);
    return new Date(year!, month! - 1, day);
}

/** FNV-1a，和作息固定选空闲活动的算法一致。 */
function stableHash(text: string): number {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

// ---------- 读卡：转换器写出的 extensions.qqbot.moods / books ----------

export function parseMoods(value: unknown, source: string): DailyMood[] {
    if (value === undefined) return [];
    const fail = (at: string): never => { throw new Error(`${source}：extensions.qqbot.moods${at}`); };
    const array = (v: unknown, at: string): unknown[] => Array.isArray(v) ? v : fail(`${at} 应为数组`);
    const object = (v: unknown, at: string): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${at} 应为对象`);
    const text = (v: unknown, at: string): string => typeof v === 'string' && v.trim() ? v.trim() : fail(`${at} 应为非空字符串`);
    const number = (v: unknown, at: string): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fail(`${at} 应为正数`);
    const moods = array(value, '').map((raw, i): DailyMood => {
        const mood = object(raw, `[${i}]`);
        const when = array(mood.when, `[${i}].when`).map((condition, j) => {
            const item = object(condition, `[${i}].when[${j}]`);
            const day = text(item.day, `[${i}].when[${j}].day`) as MoodDay;
            if (!MOOD_DAYS.includes(day)) fail(`[${i}].when[${j}].day 不认识：${day}`);
            return { day, factor: number(item.factor, `[${i}].when[${j}].factor`), reason: text(item.reason, `[${i}].when[${j}].reason`) };
        });
        return { name: text(mood.name, `[${i}].name`), weight: number(mood.weight, `[${i}].weight`), style: text(mood.style, `[${i}].style`), when };
    });
    if (new Set(moods.map(mood => mood.name)).size !== moods.length) fail(' 心情名字重复');
    return moods;
}

export function parseBooks(value: unknown, source: string): ReadingBook[] {
    if (value === undefined) return [];
    const fail = (at: string): never => { throw new Error(`${source}：extensions.qqbot.books${at}`); };
    const array = (v: unknown, at: string): unknown[] => Array.isArray(v) ? v : fail(`${at} 应为数组`);
    const object = (v: unknown, at: string): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${at} 应为对象`);
    const text = (v: unknown, at: string): string => typeof v === 'string' && v.trim() ? v.trim() : fail(`${at} 应为非空字符串`);
    const strings = (v: unknown, at: string): string[] => array(v, at).map((item, i) => text(item, `${at}[${i}]`));
    const integer = (v: unknown, at: string, min = 0): number => Number.isInteger(v) && (v as number) >= min ? v as number : fail(`${at} 应为不小于 ${min} 的整数`);
    const books = array(value, '').map((raw, i): ReadingBook => {
        const book = object(raw, `[${i}]`);
        const progressRaw = object(book.progress, `[${i}].progress`);
        const state = text(progressRaw.state, `[${i}].progress.state`);
        if (state !== 'reading' && state !== 'put_down') fail(`[${i}].progress.state 应为 reading 或 put_down`);
        const unit = text(progressRaw.unit, `[${i}].progress.unit`);
        const max = progressRaw.max === undefined ? undefined : integer(progressRaw.max, `[${i}].progress.max`);
        const progress = {
            startDay: text(progressRaw.startDay, `[${i}].progress.startDay`),
            start: integer(progressRaw.start, `[${i}].progress.start`),
            everyDays: integer(progressRaw.everyDays, `[${i}].progress.everyDays`, 1),
            amount: integer(progressRaw.amount, `[${i}].progress.amount`), unit, ...(max === undefined ? {} : { max }), state,
        } as ReadingBook['progress'];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(progress.startDay)) fail(`[${i}].progress.startDay 格式不对`);
        if (max !== undefined && progress.start > max) fail(`[${i}].progress.start 不能大于 max`);
        let total: ReadingBook['total'];
        if (book.total !== undefined) {
            const item = object(book.total, `[${i}].total`);
            total = { amount: integer(item.amount, `[${i}].total.amount`, 1), unit: text(item.unit, `[${i}].total.unit`) };
            if (total.unit !== unit) fail(`[${i}].total.unit 要和 progress.unit 一样`);
        }
        const nodes = array(book.nodes, `[${i}].nodes`).map((rawNode, j) => {
            const node = object(rawNode, `[${i}].nodes[${j}]`);
            return {
                id: text(node.id, `[${i}].nodes[${j}].id`), topic: text(node.topic, `[${i}].nodes[${j}].topic`),
                from: integer(node.from, `[${i}].nodes[${j}].from`), keywords: strings(node.keywords, `[${i}].nodes[${j}].keywords`),
                points: strings(node.points, `[${i}].nodes[${j}].points`),
            };
        });
        return {
            id: text(book.id, `[${i}].id`), title: text(book.title, `[${i}].title`), aliases: strings(book.aliases, `[${i}].aliases`),
            author: text(book.author, `[${i}].author`), kind: text(book.kind, `[${i}].kind`), platform: text(book.platform, `[${i}].platform`),
            status: text(book.status, `[${i}].status`), ...(total ? { total } : {}), progress,
            attitude: text(book.attitude, `[${i}].attitude`), unreadKeywords: strings(book.unreadKeywords, `[${i}].unreadKeywords`), nodes,
        };
    });
    if (new Set(books.map(book => book.id)).size !== books.length) fail(' 书的 id 重复');
    return books;
}
