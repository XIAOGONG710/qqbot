// 主动消息（ADR 0011 决策 2、6）：她什么时候主动找人。都是纯函数，按作息、聊天记录、发送记录和时间算；
// 随机的部分按「联系人 + 她的那一天 + 时机」取种子，重启后算出同一个时刻。定时、记录文件和发送在计划器里（app.ts）。
//
// 「她的那一天」：从这一天的睡觉时刻（02:00）到第二天的睡觉时刻，和 schedule.ts 一样，00:00–02:00 算前一天的晚上。
// 每一天的候选：早安、下课、睡前、冷场、待跟进的事、重要的日子，各一个时刻；到点时再查一遍能不能发（blockReason）。
// 每天的条数有上限：候选比剩下的条数多时按优先级留（日子 > 待跟进 > 早安 > 下课 > 冷场 > 睡前），日子不受上限和「没回就停」限制。
// 错过的不补：到点时没在跑、或者过了 GRACE_MS 才算到的候选，这一天就不发了。

import type { StoredMessage } from './history.ts';
import { pendingMessages, pick } from './reply-timing.ts';
import { classesOn, formatDate, stateAt, wakeOn, type Schedule } from './schedule.ts';

/** 时机，按优先级从高到低 */
export const OCCASIONS = ['dates', 'follow_up', 'morning', 'after_class', 'quiet', 'bedtime'] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** 档位上的设置（卡的 extensions.qqbot.proactive） */
export interface ProactiveSettings {
    occasions: Occasion[];
    /** 每天最多几条（日子不算在内） */
    dailyMax: number;
    /** 她主动发的、他还没回的到了这么多条就停，等他回 */
    unansweredMax: number;
}

/** 重要的日子（卡的 extensions.qqbot.dates）：date 公历、lunar 农历，MM-DD；都写时公历那天主动提，农历那天只在时间块里提 */
export interface ImportantDay {
    name: string;
    date?: string;
    lunar?: string;
    /** 当天零点主动发（否则并进当天的早安） */
    midnight?: boolean;
}

/** 运行开关（插件配置）：关 / 试运行（照算照生成，只写日志不发）/ 开 */
export const PROACTIVE_MODES = ['off', 'dryRun', 'on'] as const;
export type ProactiveMode = (typeof PROACTIVE_MODES)[number];

/** 一次主动的结果，记在 <数据目录>/proactive/<QQ>-<档位>.json（ADR 0011 决策 5） */
export interface ProactiveRecord {
    /** <她的那一天>:<时机>；零点的日子再加 :midnight */
    id: string;
    occasion: Occasion;
    /** 计划的时刻（ISO） */
    plannedAt: string;
    /** 判断（和发送）的时刻（ISO） */
    at: string;
    /** sent 发了；dryRun 试运行，本来要发；skipped 到点时不发（reason）；failed 生成或发送出错（不再试） */
    result: 'sent' | 'dryRun' | 'skipped' | 'failed';
    reason?: string;
    /** 发出去的 QQ 消息 id */
    messageIds?: number[];
}

/** 某一天的一个候选 */
export interface Candidate {
    id: string;
    occasion: Occasion;
    /** 她的哪一天（YYYY-MM-DD） */
    day: string;
    /** 毫秒时间戳 */
    at: number;
    /** 日志和提示词里说明为什么是这个时候，例如「起床后 12 分钟」 */
    reason: string;
    /** 日子：是哪几个（同一天的几个并成一条） */
    importantDays?: ImportantDay[];
    /** 下课：几点下的课（之后聊过就不发） */
    classEnd?: number;
}

export interface ProactiveInput {
    qq: number;
    schedule: Schedule;
    settings: ProactiveSettings;
    dates: readonly ImportantDay[];
    /** 这一档的聊天记录（换档前的已经去掉） */
    history: readonly StoredMessage[];
    records: readonly ProactiveRecord[];
    mode: 'dryRun' | 'on';
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 到点之后过了这么久才算到（bot 停着、断线）就算错过，不补 */
export const GRACE_MS = 10 * MIN;
/** 夜里这个时刻之后不主动（到她起床；日子的零点除外，那时还不到这个点） */
export const NIGHT_FROM = '00:30';
/** 这么久之内双方说过话，就不主动（正聊着，或者刚聊完） */
export const RECENT_MS = HOUR;
/** 冷场：双方这么久没说话 */
export const QUIET_MS = 8 * HOUR;
const MORNING_MIN: [number, number] = [10, 40];
const AFTER_CLASS_MIN: [number, number] = [5, 20];
/** 睡前：23:00 起这么多分钟之内（到 00:30） */
const BEDTIME_FROM = '23:00';
const BEDTIME_MIN: [number, number] = [0, 90];
const QUIET_JITTER_MIN: [number, number] = [0, 30];
/** 冷场不早于起床后这么久 */
const QUIET_AFTER_WAKE_MS = HOUR;
/** 零点的日子：00:00 之后这么多分钟之内 */
const MIDNIGHT_MIN: [number, number] = [0, 5];
/** 落在上课时间里的候选推到下课后这么多分钟 */
const PUSHED_MIN: [number, number] = [5, 15];
/** 道过晚安：她或他最后一句里有这些 */
const GOODNIGHT = /晚安|睡了|去睡|先睡|睡吧|早点睡|明天见|明天聊/;

const minutes = ([a, b]: [number, number]): [number, number] => [a * MIN, b * MIN];

/** 某一天的 HH:MM（本地时间） */
function at(day: Date, time: string): Date {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(day: Date, n: number): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
}

/** 这一刻属于她的哪一天：睡觉时刻（02:00）之前算前一天 */
export function herDay(schedule: Schedule, now: Date): Date {
    const date = startOfDay(now);
    return now < at(date, schedule.sleep) ? addDays(date, -1) : date;
}

const pad = (n: number | string) => String(n).padStart(2, '0');
const LUNAR = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' });

/** 农历的 MM-DD；闰月返回 undefined（闰月里不过生日） */
export function lunarMonthDay(date: Date): string | undefined {
    const parts = LUNAR.formatToParts(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12));
    const month = parts.find(p => p.type === 'month')?.value ?? '';
    const day = parts.find(p => p.type === 'day')?.value ?? '';
    if (!/^\d+$/.test(month) || !/^\d+$/.test(day)) return undefined;
    return `${pad(month)}-${pad(day)}`;
}

/** 这个日子落在这一天吗：solar 公历那天，lunar 农历那天 */
export function dayMatches(important: ImportantDay, date: Date): 'solar' | 'lunar' | undefined {
    if (important.date && important.date === formatDate(date).slice(5)) return 'solar';
    if (important.lunar && important.lunar === lunarMonthDay(date)) return 'lunar';
    return undefined;
}

/** 主动提的那天：写了公历就是公历那天，只写了农历就是农历那天 */
function proactiveOn(important: ImportantDay, date: Date): boolean {
    const match = dayMatches(important, date);
    return important.date ? match === 'solar' : match === 'lunar';
}

const hm = (time: number) => {
    const d = new Date(time);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 她的某一天的全部候选（还没看条件和上限），按时间排好 */
export function candidatesOn(day: Date, input: ProactiveInput): Candidate[] {
    const { schedule, settings } = input;
    const enabled = new Set(settings.occasions);
    const dayText = formatDate(day);
    const seed = (purpose: string) => `${input.qq} ${dayText} ${purpose}`;
    const wake = wakeOn(schedule, day).getTime();
    const nightFrom = at(addDays(day, 1), NIGHT_FROM).getTime();
    const list: Candidate[] = [];
    const add = (occasion: Occasion, time: number, reason: string, extra: Partial<Candidate> = {}, idSuffix = '') =>
        list.push({ id: `${dayText}:${occasion}${idSuffix}`, occasion, day: dayText, at: time, reason, ...extra });

    const morning = wake + pick(seed('morning'), 'at', minutes(MORNING_MIN));
    const names = (list: ImportantDay[]) => list.map(d => d.name).join('、');
    // 零点的日子：那天的 00:00 属于前一天（她还没睡）；别的日子并进当天的早安。同一天的几个并成一条
    const midnight = enabled.has('dates') ? input.dates.filter(d => d.midnight && proactiveOn(d, addDays(day, 1))) : [];
    const atMorning = enabled.has('dates') ? input.dates.filter(d => !d.midnight && proactiveOn(d, day)) : [];
    if (midnight.length) {
        add('dates', addDays(day, 1).getTime() + pick(seed('dates midnight'), 'at', minutes(MIDNIGHT_MIN)),
            `今天是${names(midnight)}，零点`, { importantDays: midnight }, ':midnight');
    }
    if (atMorning.length) add('dates', morning, `今天是${names(atMorning)}，起床后`, { importantDays: atMorning });
    else if (enabled.has('morning')) add('morning', morning, `起床后 ${Math.round((morning - wake) / MIN)} 分钟`);

    if (enabled.has('after_class')) {
        const last = classesOn(schedule, day).lessons.at(-1);
        if (last) {
            const end = last.end.getTime();
            add('after_class', end + pick(seed('after_class'), 'at', minutes(AFTER_CLASS_MIN)), `今天的课 ${hm(end)} 上完了`, { classEnd: end });
        }
    }

    if (enabled.has('bedtime')) add('bedtime', at(day, BEDTIME_FROM).getTime() + pick(seed('bedtime'), 'at', minutes(BEDTIME_MIN)), '准备睡了');

    const last = input.history.at(-1);
    if (enabled.has('quiet') && last) {
        const lastTime = Date.parse(last.time);
        const time = Math.max(lastTime + QUIET_MS, wake + QUIET_AFTER_WAKE_MS) + pick(seed('quiet'), 'at', minutes(QUIET_JITTER_MIN));
        // 隔了多久写在时间块里（「上一条消息」那一行），这里不写数字：时刻可能被推到下课后
        add('quiet', time, '你们大半天没说话了');
    }

    // 落在上课时间里的推到下课后；推完过了夜里的时刻、或者在睡觉的，这一天就没有了
    const kept: Candidate[] = [];
    for (const candidate of list) {
        const atMidnight = candidate.id.endsWith(':midnight');
        const state = stateAt(schedule, new Date(candidate.at));
        if (!atMidnight && state.activity.kind === 'class') {
            candidate.at = state.activity.lesson.end.getTime() + pick(seed(`${candidate.id} pushed`), 'at', minutes(PUSHED_MIN));
        }
        if (!atMidnight && candidate.at >= nightFrom) continue;
        if (stateAt(schedule, new Date(candidate.at)).activity.kind === 'sleep') continue;
        kept.push(candidate);
    }
    return kept.sort((a, b) => a.at - b.at);
}

const counts = (r: ProactiveRecord) => r.result === 'sent' || r.result === 'dryRun';

/** 她的这一天里已经主动了几条（日子不算） */
export function usedOn(day: string, records: readonly ProactiveRecord[]): number {
    return records.filter(r => r.id.startsWith(`${day}:`) && r.occasion !== 'dates' && counts(r)).length;
}

/** 他最后一条消息之后，她主动发了几条（试运行时算试运行的记录，打开时算真发的） */
export function unansweredCount(input: Pick<ProactiveInput, 'history' | 'records' | 'mode'>): number {
    const lastUser = input.history.findLast(m => m.role === 'user');
    const since = lastUser ? Date.parse(lastUser.time) : -Infinity;
    const kind = input.mode === 'on' ? 'sent' : 'dryRun';
    return input.records.filter(r => r.result === kind && Date.parse(r.at) > since).length;
}

export interface Plan {
    /** 接下来要发的候选（这一天的，没有就看下一天的），按时间排 */
    upcoming: Candidate[];
    /** 这一天到点已经过了 GRACE_MS 还没记过的：错过了，不补 */
    missed: Candidate[];
    /** 这一天让给优先级更高的（剩下的条数不够） */
    yielded: Candidate[];
}

/**
 * 现在往后的计划：这一天还没记过、没错过的候选，按优先级留下剩下的条数（日子都留）；
 * 这一天没有了就看下一天（状态页显示「明天 09:52 早安」）。
 */
export function planFrom(now: number, input: ProactiveInput): Plan {
    const recorded = new Set(input.records.map(r => r.id));
    const today = herDay(input.schedule, new Date(now));
    const missed: Candidate[] = [];
    const yielded: Candidate[] = [];
    for (const [offset, day] of [today, addDays(today, 1)].entries()) {
        const all = candidatesOn(day, input).filter(c => !recorded.has(c.id));
        if (offset === 0) missed.push(...all.filter(c => c.at < now - GRACE_MS));
        const open = all.filter(c => c.at >= now - GRACE_MS);
        const left = Math.max(0, input.settings.dailyMax - usedOn(formatDate(day), input.records));
        const byPriority = open.filter(c => c.occasion !== 'dates').sort((a, b) => OCCASIONS.indexOf(a.occasion) - OCCASIONS.indexOf(b.occasion));
        const kept = new Set([...open.filter(c => c.occasion === 'dates'), ...byPriority.slice(0, left)]);
        if (offset === 0) yielded.push(...byPriority.slice(left));
        const upcoming = open.filter(c => kept.has(c));
        if (upcoming.length) return { upcoming, missed, yielded };
    }
    return { upcoming: [], missed, yielded };
}

/** 到点时还能不能发：不能就返回原因（记进记录和日志） */
export function blockReason(candidate: Candidate, now: number, input: ProactiveInput): string | undefined {
    const { schedule, history } = input;
    const state = stateAt(schedule, new Date(now));
    if (state.activity.kind === 'sleep') return '她在睡觉';
    if (state.activity.kind === 'class') return '她在上课';
    const special = candidate.occasion === 'dates';
    const day = herDay(schedule, new Date(now));
    if (!special && now >= at(addDays(day, 1), NIGHT_FROM).getTime()) return '夜里了，不打扰';
    if (pendingMessages([...history]).length) return '有没回的消息，回复就好';
    const last = history.at(-1);
    const lastTime = last ? Date.parse(last.time) : undefined;
    if (special) return undefined;
    if (lastTime !== undefined && now - lastTime < RECENT_MS) return '一小时内聊过';
    const used = usedOn(candidate.day, input.records);
    if (used >= input.settings.dailyMax) return `今天已经主动了 ${used} 条`;
    if (unansweredCount(input) >= input.settings.unansweredMax) return '上一条主动消息他还没回';
    const wake = wakeOn(schedule, day).getTime();
    const userSince = (time: number) => history.some(m => m.role === 'user' && Date.parse(m.time) >= time);
    switch (candidate.occasion) {
        case 'morning':
            if (userSince(wake)) return '他今天已经来过消息';
            break;
        case 'after_class':
            if (lastTime !== undefined && lastTime >= candidate.classEnd!) return '下课后已经聊过';
            break;
        case 'bedtime':
            if (!userSince(wake)) return '今天没聊过';
            if (last && GOODNIGHT.test(last.content)) return '已经道过晚安';
            break;
        case 'quiet':
            if (lastTime === undefined || now - lastTime < QUIET_MS) return '没到 8 小时';
            break;
    }
    return undefined;
}

/** 主动发的最多几条气泡 */
export const MAX_PROACTIVE_BUBBLES = 2;

/** 提示词里的说明（ADR 0011 决策 3）：这次是你主动找他、为什么。userName 是称呼（{{user}}） */
export function occasionNote(candidate: Candidate, userName: string): string {
    const names = candidate.importantDays?.map(d => d.name).join('、') ?? '';
    const why: Record<Occasion, () => string> = {
        morning: () => `你起床没多久，跟${userName}说早安`,
        after_class: () => `你今天的课上完了，跟${userName}说一声`,
        bedtime: () => `时间不早了，跟${userName}道个晚安`,
        quiet: () => `你们大半天没说话了，你想找${userName}说两句（对方可能在忙，别怪对方没找你）`,
        follow_up: () => candidate.reason,
        dates: () => (candidate.id.endsWith(':midnight')
            ? `零点了，今天是${names}，你一直记着，第一时间跟${userName}说`
            : `今天是${names}。你起床没多久，跟${userName}说早安，也提一句这个日子`),
    };
    return `[这次是你主动找${userName}：${why[candidate.occasion]()}。只发一两句，像平时随手发的消息。]`;
}

/** 日志、状态页里的说法：「早安（起床后 12 分钟）」 */
export const OCCASION_LABELS: Record<Occasion, string> = {
    dates: '重要的日子', follow_up: '待跟进的事', morning: '早安', after_class: '下课', quiet: '冷场', bedtime: '睡前',
};

export function candidateLabel(candidate: Candidate): string {
    return `${OCCASION_LABELS[candidate.occasion]}（${candidate.reason}）`;
}

// ---------- 读卡 ----------

const MONTH_DAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** 卡的 extensions.qqbot.dates（转换器写的，手改坏了要早报错） */
export function parseDates(json: unknown, source: string): ImportantDay[] {
    if (json === undefined) return [];
    const fail = (what: string): never => { throw new Error(`${source}：extensions.qqbot.dates${what}`); };
    if (!Array.isArray(json)) fail(' 应为数组');
    return (json as unknown[]).map((raw, i) => {
        const o = (typeof raw === 'object' && raw !== null ? raw : fail(`[${i}] 应为对象`)) as Record<string, unknown>;
        if (typeof o.name !== 'string' || !o.name) fail(`[${i}].name 应为非空字符串`);
        for (const key of ['date', 'lunar'] as const) {
            if (o[key] !== undefined && !(typeof o[key] === 'string' && MONTH_DAY.test(o[key]))) fail(`[${i}].${key} 应为 MM-DD`);
        }
        if (o.date === undefined && o.lunar === undefined) fail(`[${i}] 要有 date 或 lunar`);
        if (o.midnight !== undefined && typeof o.midnight !== 'boolean') fail(`[${i}].midnight 应为 true 或 false`);
        return {
            name: o.name as string,
            ...(o.date !== undefined ? { date: o.date as string } : {}),
            ...(o.lunar !== undefined ? { lunar: o.lunar as string } : {}),
            ...(o.midnight === true ? { midnight: true } : {}),
        };
    });
}

/** 卡的 extensions.qqbot.proactive */
export function parseProactive(json: unknown, source: string): ProactiveSettings {
    const fail = (what: string): never => { throw new Error(`${source}：extensions.qqbot.proactive${what}`); };
    const o = (typeof json === 'object' && json !== null && !Array.isArray(json) ? json : fail(' 应为对象')) as Record<string, unknown>;
    if (!Array.isArray(o.occasions) || !o.occasions.every(x => OCCASIONS.includes(x as Occasion))) fail(`.occasions 应为 ${OCCASIONS.join(' / ')} 组成的数组`);
    const count = (key: 'dailyMax' | 'unansweredMax') => (Number.isInteger(o[key]) && (o[key] as number) >= 1 ? o[key] as number : fail(`.${key} 应为正整数`));
    return { occasions: o.occasions as Occasion[], dailyMax: count('dailyMax'), unansweredMax: count('unansweredMax') };
}

