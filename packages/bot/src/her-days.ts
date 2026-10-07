// 她自己的日子（ADR 0015）：每日心情和在读的书。这里都是纯函数；接进时间块和出口检查在 contact.ts，日志和开关在 app.ts。

import type { StoredMessage } from './history.ts';
import type { BodyNow } from './body.ts';
import type { WorldNow } from './world.ts';
import { classesOn, formatDate, herDay, type ExtraFreeActivity, type Schedule } from './schedule.ts';

/** 判断聊没聊到书只看谁说的、说了什么 */
type Said = Pick<StoredMessage, 'role' | 'content'>;

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
    activity?: { window: 'morning' | 'afternoon' | 'evening'; text: string };
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

export interface MoodContext {
    body?: BodyNow;
    world?: WorldNow;
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
export function moodAt(schedule: Schedule, moods: readonly DailyMood[], now: Date, forcedName?: string, context: MoodContext = {}): MoodChoice | undefined {
    if (!moods.length) return undefined;
    const day = herDay(schedule, now);
    const conditions = moodDayConditions(schedule, day);
    const weighted = moods.map(mood => {
        const matched = mood.when.filter(item => conditions.includes(item.day));
        return { mood, matched, weight: mood.weight * matched.reduce((value, item) => value * item.factor, 1) };
    });
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let point = (stableHash(`${formatDate(day)} mood`) / 0x1_0000_0000) * total;
    const selected = forcedName === undefined
        ? weighted.find(item => (point -= item.weight) < 0) ?? weighted.at(-1)!
        : weighted.find(item => item.mood.name === forcedName);
    if (!selected) return undefined;
    // 模拟器显式指定心情时保持场景可控；正常运行时，身体事实会把高能量的日常底色压低。
    // 不把这个结果存起来：同一天的痛经/感冒是一整天的底色，困和累只影响当下。
    const grounding = forcedName === undefined ? groundedMood(context, now) : undefined;
    const grounded = grounding ? weighted.find(item => item.mood.name === '安静') ?? selected : selected;
    // 同时命中早八和课多时，取资料里排在前面的那条；原因仍然是真的，不拼成一长串。
    return {
        day: formatDate(day), mood: grounded.mood,
        reason: grounding?.reason ?? grounded.matched[0]?.reason ?? FALLBACK_REASON,
        conditions,
    };
}

function groundedMood({ body, world }: MoodContext, now: Date): { reason: string } | undefined {
    if (body?.period?.cramps === 'bad') return { reason: body.period.detail ? '今天肚子疼得厉害，没什么精神' : '今天身上不太舒服，没什么精神' };
    if (body?.period?.cramps === 'mild') return { reason: body.period.detail ? '今天肚子隐隐地疼，不太想动' : '今天身上有点不舒服，不太想动' };
    if (body?.cold) return { reason: body.cold.day === body.cold.of ? '感冒还没好利索，精神一般' : '今天有点感冒，没什么精神' };
    if (body?.sleepy?.when === 'morning') return { reason: '昨晚睡得晚，今早又起得早，有点困' };
    if (body?.sleepy?.when === 'late') return { reason: '已经很晚了，有点困' };
    if (body?.tired) return { reason: '今天课多，这会儿有点累' };
    // 事件只采用不需要猜情绪的明确压力源；普通下雨、小事和 NPC 互动不做正负脑补。
    if (world?.cat && 'skipped' in world.cat.today && world.cat.today.skipped === 'no_food') {
        return { reason: `${world.cat.name}的猫粮没了，今天没喂成，心里有点挂着` };
    }
    if (world?.homework.some(item => !item.done && item.due.getTime() - now.getTime() <= DAY_MS)) {
        return { reason: '有份作业快到截止时间了，心里还挂着' };
    }
    return undefined;
}

/** 放在状态行下面的每日心情；只写今天怎么说，不写禁令。时间块不走宏替换，{{user}} 在这里换成称呼 */
export function describeMood(choice: MoodChoice, userName: string): string {
    return `[你今天的心情：${choice.mood.name}（${choice.reason}）。${choice.mood.style.replaceAll('{{user}}', userName)}]`;
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
    if (book.unreadKeywords.some(keyword => normalized.includes(keyword.toLowerCase()))) topics.push('后面的情节');
    return [...new Set(topics)];
}

export interface BookMention {
    mentioned: boolean;
    /** 泛问「在看什么书」时是全部；点到某本书、作者或人物时只列命中的书 */
    bookIds: string[];
    /** 点名了某本书（书名、作者、人物……），不是泛问 */
    named: boolean;
}

// 泛问书的说法。不收单个「书」：「图书馆」「书包」天天说，10-05 全部模拟器材料的非书场景里误触发 26 次
const BOOK_WORDS = /看书|读书|什么书|本书|这书|那书|书名|小说|网文|看到哪|读到哪|追更/;
/**
 * 节点关键词里平时聊天也常说的词，单独出现不算点名这本书（10-05 非书场景误触发 94 次，大头是「更新」「最后」「哪来的」「番茄」「成绩」）。
 * 书正聊着时书名还在最近的话里，节点照样按他的话挑（describeBooks）。
 */
const COMMON_WORDS = new Set([
    '小说', '轻小说', '女主', '男主', '主角', '男主谁', '那个女的', '谁', '猫猫', '剧情', '讲什么', '讲啥', '讲的是什么', '主线', '好看吗', '好看不',
    '作者', '谁写的', '原作', '哪来的', '出版', '实体书', '完结', '动画', '动画版', '番', '追番', 'b站', '第几集', '更新', '看了吗',
    '结局', '大结局', '结尾', '最后', '后面那个', '死了没', '死了吗', '死没死', '病重', '案子', '复仇', '回京', '身世', '后来怎么样',
    '后面讲什么', '后面在讲啥', '后面讲啥', '成绩', '评分', '火吗', '电视剧', '影视', '马甲', '身份', '平台', '哪看', '在哪看', '番茄', '起点',
]);

/** 最近：他的最后 3 条、她的最后 2 次回复。 */
export function bookMention(history: readonly Said[], books: readonly ReadingBook[]): BookMention {
    const his = history.map((message, index) => ({ message, index })).filter(item => item.message.role === 'user').slice(-3)
        .map(item => ({ index: item.index, text: item.message.content }));
    const replies: { index: number; texts: string[] }[] = [];
    let inReply = false;
    for (const [index, message] of history.entries()) {
        if (message.role === 'assistant') {
            if (!inReply) replies.push({ index, texts: [] });
            replies.at(-1)!.texts.push(message.content);
            replies.at(-1)!.index = index;
            inReply = true;
        } else {
            inReply = false;
        }
    }
    const recent = [...his, ...replies.slice(-2).map(item => ({ index: item.index, text: item.texts.join('\n') }))].sort((a, b) => b.index - a.index);
    for (const item of recent) {
        const text = item.text.toLowerCase();
        const ids = books.filter(book => specificBookTerms(book).some(term => text.includes(term.toLowerCase()))).map(book => book.id);
        if (ids.length) return { mentioned: true, bookIds: ids, named: true };
        if (BOOK_WORDS.test(text)) return { mentioned: true, bookIds: books.map(book => book.id), named: false };
    }
    return { mentioned: false, bookIds: [], named: false };
}

/** 状态行的空闲活动是不是在看资料里的书。 */
export function readingActivity(text: string, books: readonly ReadingBook[]): boolean {
    return /看书|读书/.test(text) || books.some(book => [book.title, ...book.aliases].some(term => term && text.includes(term)));
}

/** books.yml 里的活动只在 herDays 开着时并入作息。 */
export function readingActivities(books: readonly ReadingBook[]): ExtraFreeActivity[] {
    return books.flatMap(book => book.activity ? [{ ...book.activity }] : []);
}

export interface DescribedBooks {
    text: string;
    /** 出口检查的进度数字规则用（speech-check.ts 的 BookProgressContext） */
    context: { books: { book: ReadingBook; progress: BookProgress }[]; focusIds: string[] };
}

/**
 * 「在读的书」那一段：每本书的进度、你的感受和读到的内容，最后一句写怎么说。
 * named 里的书（他点名问的）给全部读到的节点；其余的给他这次的话问到的节点，加上主角、主线各一句（关键词里有「主角」「主线」的节点），
 * 泛问「在看什么书」时也有情节可说，不用自己补。
 */
export function describeBooks(schedule: Schedule, books: readonly ReadingBook[], now: Date,
    options: { userText: string; userName: string; named?: readonly string[] }): DescribedBooks | undefined {
    if (!books.length) return undefined;
    const { userName } = options;
    const asked = options.userText.toLowerCase();
    const named = new Set(options.named ?? []);
    const items = books.map(book => ({ book, progress: bookProgressAt(schedule, book, now) }));
    const lines = items.flatMap(({ book, progress }) => {
        const position = progress.finished ? '已经读完了'
            : book.progress.state === 'put_down' ? `停在第 ${progress.amount} ${progress.unit}，已经放下了`
                : `看到第 ${progress.amount} ${progress.unit}${progress.stopped ? '，先停在这里' : ''}`;
        const total = book.total ? `；全书 ${book.total.amount} ${book.total.unit}` : '';
        const nodes = availableBookNodes(book, progress).flatMap(node => {
            if (named.has(book.id) || node.keywords.some(keyword => asked.includes(keyword.toLowerCase()))) return [`  ${node.topic}：${node.points.join('；')}`];
            return node.keywords.includes('主角') || node.keywords.includes('主线') ? [`  ${node.topic}：${node.points[0]}`] : [];
        });
        return [`- 《${book.title}》（${book.author}；${book.kind}；${book.platform}；${book.status}）：${position}${total}；你的感受：${book.attitude}`, ...nodes];
    });
    // 点名问了哪本，只提醒那本没看到的地方；泛问时每本都看
    const unread = items.filter(({ book }) => !named.size || named.has(book.id))
        .flatMap(({ book, progress }) => unreadBookTopics(book, progress, options.userText)
            .map(topic => `${userName}问的《${book.title}》${topic}你还没看到`));
    return {
        text: ['[在读的书：', ...lines, ...unread,
            `怎么说：聊书只聊上面这些；${userName}问到这里没有的情节、你还没看到的地方，就说还没看到那儿，或者记不清了，也可以问问${userName}看到哪了。]`,
        ].join('\n'),
        context: { books: items, focusIds: named.size ? [...named] : books.map(book => book.id) },
    };
}

/**
 * 这一轮放不放「在读的书」（决策 2）：最近聊到书（bookMention），或者她这会儿的空闲活动是看书；都不是就没有。
 * activity：状态行里的空闲活动（没在空闲、作息关着时不传）。userText 取他在她上次回复之后发的几条
 */
export function readingSection(schedule: Schedule, books: readonly ReadingBook[], now: Date,
    options: { history: readonly Said[]; userName: string; activity?: string }): DescribedBooks | undefined {
    if (!books.length) return undefined;
    const mention = bookMention(options.history, books);
    let chosen = mention.mentioned ? books.filter(book => mention.bookIds.includes(book.id)) : [];
    if (!chosen.length && options.activity && readingActivity(options.activity, books)) {
        const reading = books.filter(book => [book.title, ...book.aliases].some(term => term && options.activity!.includes(term)));
        chosen = reading.length ? reading : [...books];
    }
    if (!chosen.length) return undefined;
    const lastReply = options.history.findLastIndex(message => message.role === 'assistant');
    const userText = options.history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
    return describeBooks(schedule, chosen, now, { userText, userName: options.userName, named: mention.named ? mention.bookIds : [] });
}

/** 启动和每天第一次生成时的摘要：心情、原因和进度，不含聊天内容。 */
export function describeHerDaySummary(schedule: Schedule, moods: readonly DailyMood[], books: readonly ReadingBook[], now: Date, forcedMood?: string, context: MoodContext = {}): string | undefined {
    const mood = moodAt(schedule, moods, now, forcedMood, context);
    if (!mood && !books.length) return undefined;
    const reading = books.map(book => {
        const progress = bookProgressAt(schedule, book, now);
        return `${book.title}${progress.finished ? ' 读完了' : ` 第 ${progress.amount} ${progress.unit}${book.progress.state === 'put_down' ? '（放下了）' : ''}`}`;
    }).join('、');
    return `今天（${formatDate(herDay(schedule, now)).slice(5)}）：${mood ? `心情 ${mood.mood.name}（${mood.reason}）` : '没有心情资料'}${reading ? `；在读 ${reading}` : ''}`;
}

/** 按她的一天去重：这一天第一次调用时写一行摘要，同一天再调不写 */
export function herDayLogger(schedule: Schedule, moods: readonly DailyMood[], books: readonly ReadingBook[], log: (message: string) => void,
    forcedMood?: string, contextAt?: (now: Date) => MoodContext): (now: Date) => void {
    let logged: string | undefined;
    return now => {
        const day = formatDate(herDay(schedule, now));
        if (day === logged) return;
        logged = day;
        const summary = describeHerDaySummary(schedule, moods, books, now, forcedMood, contextAt?.(now));
        if (summary) log(`她自己的日子：${summary}`);
    };
}

function bookTerms(book: ReadingBook): string[] {
    return [book.title, ...book.aliases, book.author, ...book.unreadKeywords,
        ...book.nodes.flatMap(node => [...node.keywords, ...node.points])].filter(term => term.length >= 2);
}

function specificBookTerms(book: ReadingBook): string[] {
    return bookTerms(book).filter(term => !COMMON_WORDS.has(term));
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
            status: text(book.status, `[${i}].status`), ...parseActivity(book.activity, `[${i}].activity`), ...(total ? { total } : {}), progress,
            attitude: text(book.attitude, `[${i}].attitude`), unreadKeywords: strings(book.unreadKeywords, `[${i}].unreadKeywords`), nodes,
        };
    });
    if (new Set(books.map(book => book.id)).size !== books.length) fail(' 书的 id 重复');
    return books;

    function parseActivity(value: unknown, at: string): { activity?: ReadingBook['activity'] } {
        if (value === undefined) return {};
        const item = object(value, at);
        const window = text(item.window, `${at}.window`) as NonNullable<ReadingBook['activity']>['window'];
        if (!['morning', 'afternoon', 'evening'].includes(window)) fail(`${at}.window 应为 morning / afternoon / evening`);
        return { activity: { window, text: text(item.text, `${at}.text`) } };
    }
}
