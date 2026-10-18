// 主动消息（ADR 0011 决策 2、6）：她什么时候主动找人。都是纯函数，按作息、聊天记录、发送记录和时间算；
// 随机的部分按「联系人 + 她的那一天 + 时机」取种子，重启后算出同一个时刻。定时、记录文件和发送在计划器里（app.ts）。
//
// 「她的那一天」：从这一天的睡觉时刻（02:00）到第二天的睡觉时刻，和 schedule.ts 一样，00:00–02:00 算前一天的晚上。
// 每一天的候选：早安、下课、睡前、冷场、待跟进的事、重要的日子、下雨（ADR 0050，只认真实天气）、她那边的事（ADR 0057），各一个时刻；到点时再查一遍能不能发（blockReason）。
// 每天的条数有上限：候选比剩下的条数多时按优先级留（日子 > 她那边的事 > 待跟进 > 下雨 > 早安 > 下课 > 冷场 > 睡前），日子不受上限和「没回就停」限制。
// 错过的不补：到点时没在跑、或者过了 GRACE_MS 才算到的候选，这一天就不发了。
// 没连上模型的（断网）不算错过：记录里带 retryAt 的候选按那个时刻再排，最多 UNREACHABLE_MAX_TRIES 次，只在同一天里。

import { expired, firstAsk, partText, whenText, type FollowUp } from './follow-ups.ts';
import type { StoredMessage } from './history.ts';
import type { ObstacleKind } from './obstacles.ts';
import { mentionsMeetup } from './promises.ts';
import { pendingMessages, pick } from './reply-timing.ts';
import { classesOn, formatDate, herDay, stateAt, wakeOn, type Schedule } from './schedule.ts';
import { logBody } from './sensitive.ts';
export { herDay } from './schedule.ts';

/** 时机，按优先级从高到低 */
export const OCCASIONS = ['dates', 'reschedule', 'news', 'follow_up', 'weather', 'morning', 'after_class', 'quiet', 'bedtime'] as const;
export type Occasion = (typeof OCCASIONS)[number];

/** 「她那边的事」的事件类（ADR 0064），按优先级从高到低：买到相机、24 小时内到期的作业写完了、一段不舒服的第一天、闺蜜临时去不了 / 改到很晚（ADR 0061，开着配置 npcAsks 才有） */
export const NEWS_KINDS = ['camera', 'homework_done', 'unwell', 'friend_changed', 'friend_sick'] as const;
export type NewsKind = (typeof NEWS_KINDS)[number];
/** 卡上没写 newsKinds 的按只有相机处理（0057 的行为，旧卡不变） */
export const DEFAULT_NEWS_KINDS: readonly NewsKind[] = ['camera'];

/** 档位上的设置（卡的 extensions.qqbot.proactive） */
export interface ProactiveSettings {
    occasions: Occasion[];
    /** 每天最多几条（日子不算在内） */
    dailyMax: number;
    /** 她主动发的、他还没回的到了这么多条就停，等他回 */
    unansweredMax: number;
    /** 「她那边的事」开哪几类（ADR 0064）；没写 = 只有相机 */
    newsKinds?: NewsKind[];
}

export function newsKindsOf(settings: Pick<ProactiveSettings, 'newsKinds'>): readonly NewsKind[] {
    return settings.newsKinds ?? DEFAULT_NEWS_KINDS;
}

/** 重要的日子（卡的 extensions.qqbot.dates）：date 公历、lunar 农历，MM-DD；都写时公历那天主动提，农历那天只在时间块里提 */
export interface ImportantDay {
    name: string;
    date?: string;
    lunar?: string;
    /** 当天零点主动发（否则并进当天的早安） */
    midnight?: boolean;
    /** 只在这一年算（公共节日，ADR 0076：农历的日子每年落在不同的公历日，所以每年换算一条）；不写每年都算 */
    year?: number;
    /** 时间块里提前几天起提（不写 DAYS_AHEAD） */
    ahead?: number;
    /** 时间块里跟在名字后面的一句说明（公共节日：「情侣的节日」） */
    hint?: string;
    /** 只在时间块里提，不主动找他说 */
    silent?: boolean;
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
    /** sent 发了；dryRun 试运行，本来要发；skipped 到点时不发（reason）；failed 生成或发送出错（带 retryAt 的到时候再试，不带的不再试） */
    result: 'sent' | 'dryRun' | 'skipped' | 'failed';
    reason?: string;
    /** 发出去的 QQ 消息 id */
    messageIds?: number[];
    /** 没连上模型：这个时刻（ISO）再试一次，候选还开着（同一天之内；过了 GRACE_MS 才算到照样算错过） */
    retryAt?: string;
    /** 没连上模型的第几次 */
    tries?: number;
    /** 改约（ADR 0066）：因为哪一类障碍；unwell 每个周期最多一次，靠它翻记录 */
    obstacle?: ObstacleKind;
}

/** 没连上模型时，主动消息隔多久再试、一共试几次（10-11 下午断网，16:35 买到相机那条一次没连上就不再试，那天就没说成） */
export const UNREACHABLE_RETRY_MS = 15 * 60_000;
export const UNREACHABLE_MAX_TRIES = 3;

const waitingRetry = (r: ProactiveRecord) => r.result === 'failed' && r.retryAt !== undefined;

/** 她那边的一件事（ADR 0057、0064）：哪一类、她的哪一天、几点了结的、说的是什么（world.ts 的 worldNews） */
export interface NewsItem {
    id: string;
    kind: NewsKind;
    day: string;
    at: number;
    what: string;
}

/**
 * 约好之后她这边出了事、想改约的一件（ADR 0066）：约的 id（promise id）、约在她的哪一天哪个钟点、几点能跟他说、是什么障碍。
 * 由 proactive-planner.ts 的 reschedulesFrom 算（约 + 障碍都是确定性的事实）
 */
export interface RescheduleItem {
    id: string;
    /** 约的那天（她的一天） */
    day: string;
    /** 她能开口的时刻：那天起床 */
    at: number;
    /** 约的开始时刻 */
    start: number;
    /** 约的是什么：「和他去东门吃麻辣烫」 */
    what: string;
    time: string;
    where?: string;
    obstacle: { kind: ObstacleKind; id: string; text: string };
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
    /** 待跟进：问哪件事；when 是相对这一天的说法（「昨天下午」）；atMorning：并进了早安 */
    followUp?: { item: FollowUp; when: string; atMorning: boolean };
    /** 早安：他今天要经历的事（「下午 字节的面试」），说明里提一句 */
    today?: string[];
    /** 她那边的事：是哪一件 */
    news?: NewsItem;
    /** 改约：是哪一件约、什么障碍 */
    reschedule?: RescheduleItem;
}

export interface ProactiveInput {
    qq: number;
    /** 他最近说过想伤害自己的话（ADR 0068）：在暂停期里，普通主动消息不发 */
    crisisPaused?: boolean;
    schedule: Schedule;
    settings: ProactiveSettings;
    dates: readonly ImportantDay[];
    /** 这一档的聊天记录（换档前的已经去掉） */
    history: readonly StoredMessage[];
    records: readonly ProactiveRecord[];
    mode: 'dryRun' | 'on';
    /** 还没问的待跟进的事 */
    followUps?: readonly FollowUp[];
    /** 没回的那串按「不回」处理了没有（看心情不回，ADR 0013）：处理了就不算「有没回的消息」；和回复器用同一个判断 */
    skip?: (history: StoredMessage[]) => string | undefined;
    /** 她在聊天里跟谁说过「睡了」、这会儿还没到起床（ADR 0042）：和作息上在睡一样，不主动 */
    asleep?: (now: number) => boolean;
    /** 下雨（ADR 0050，真实天气）：她的哪一天、这场雨几点开始（在下的按开始的钟头，还没下的按预报）、是不是预报 */
    rain?: { day: string; start: number; forecast: boolean };
    /** 这一刻是不是真在下（实况）；到点核实，预报不准就不发 */
    rainingNow?: (now: number) => boolean;
    /** 她那边的事（ADR 0057）：她的今天、明天会了结的；到点时没有了（没发生）就不发 */
    news?: readonly NewsItem[];
    /** 约好之后出了事、想改约的（ADR 0066）：到点时障碍没了、约没了就不发 */
    reschedules?: readonly RescheduleItem[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 到点之后过了这么久才算到（bot 停着、断线）就算错过，不补 */
export const GRACE_MS = 10 * MIN;
/** 夜里这个时刻之后不主动（到她起床；日子的零点除外，那时还不到这个点） */
export const NIGHT_FROM = '00:30';
/** 这么久之内双方说过话，就不主动（正聊着，或者刚聊完） */
export const RECENT_MS = HOUR;
/**
 * 睡前用短一点的（10-06 用户定）：一小时会把「聊完停一会儿再说晚安」也挡掉——10-05 23:58 聊完，00:25 的睡前就没发。
 * 正聊着时还是不插进来；道过晚安的另有一条挡着
 */
export const BEDTIME_RECENT_MS = 20 * MIN;
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
/** 下雨：开始下之后这么多分钟（看到窗外下了，过一会儿才想起来跟他说） */
const RAIN_MIN: [number, number] = [10, 25];
/** 下雨：这个时刻以后不发（晚上下雨，提醒带伞没什么意义） */
const RAIN_UNTIL = '22:00';
/** 她那边的事：了结之后这么多分钟（在回去的路上掏出手机） */
const NEWS_MIN: [number, number] = [5, 20];
/** 她那边的事：这么久之内聊过才不发（正聊着就在聊天里说）；比别的时机短，这种事等不了一小时 */
export const NEWS_RECENT_MS = 10 * MIN;
/** 落在上课时间里的候选推到下课后这么多分钟 */
const PUSHED_MIN: [number, number] = [5, 15];
/** 待跟进：第一天问的时刻再往后抖这么多分钟；早安被日子占了时，中午 12:00 起这么多分钟 */
const FOLLOW_UP_JITTER_MIN: [number, number] = [0, 30];
const FOLLOW_UP_NOON_MIN: [number, number] = [0, 60];
/** 道过晚安：今晚（EVENING_FROM 起）她或他说过这些 */
const GOODNIGHT = /晚安|睡了|去睡|先睡|睡吧|早点睡|明天见|明天聊/;
const EVENING_FROM = '18:00';

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
    if (important.year !== undefined && important.year !== date.getFullYear()) return undefined;
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
    const midnight = enabled.has('dates') ? input.dates.filter(d => !d.silent && d.midnight && proactiveOn(d, addDays(day, 1))) : [];
    const atMorning = enabled.has('dates') ? input.dates.filter(d => !d.silent && !d.midnight && proactiveOn(d, day)) : [];
    if (midnight.length) {
        add('dates', addDays(day, 1).getTime() + pick(seed('dates midnight'), 'at', minutes(MIDNIGHT_MIN)),
            `今天是${names(midnight)}，零点`, { importantDays: midnight }, ':midnight');
    }

    // 待跟进：每天最多问一件，挑最早该问的。第一天在那件事之后问；晚上的事和第一天没问到的，之后并进早安（早安被日子占了就中午）
    let followUpAtMorning = false;
    if (enabled.has('follow_up')) {
        const due = (input.followUps ?? []).flatMap(item => {
            if (expired(item, day)) return [];
            const first = firstAsk(item);
            if (item.date === dayText && first !== undefined) return [{ item, at: first + pick(seed(`follow_up ${item.id}`), 'at', minutes(FOLLOW_UP_JITTER_MIN)), atMorning: false }];
            if (dayText <= item.date) return [];
            if (!atMorning.length) return [{ item, at: morning, atMorning: true }];
            return [{ item, at: at(day, '12:00').getTime() + pick(seed(`follow_up ${item.id} noon`), 'at', minutes(FOLLOW_UP_NOON_MIN)), atMorning: false }];
        }).sort((a, b) => a.at - b.at);
        const first = due[0];
        if (first) {
            const when = whenText(first.item, day);
            add('follow_up', first.at, `问${when}的${first.item.what}`, { followUp: { item: first.item, when, atMorning: first.atMorning } });
            followUpAtMorning = first.atMorning;
        }
    }

    if (atMorning.length) add('dates', morning, `今天是${names(atMorning)}，起床后`, { importantDays: atMorning });
    else if (enabled.has('morning') && !followUpAtMorning) {
        // 他今天要经历的事：早安里提一句
        const today = (input.followUps ?? []).filter(f => f.date === dayText).map(f => `${partText(f.time)}${f.what}`);
        add('morning', morning, `起床后 ${Math.round((morning - wake) / MIN)} 分钟`, today.length ? { today } : {});
    }

    if (enabled.has('after_class')) {
        const last = classesOn(schedule, day).lessons.at(-1);
        if (last) {
            const end = last.end.getTime();
            add('after_class', end + pick(seed('after_class'), 'at', minutes(AFTER_CLASS_MIN)), `今天的课 ${hm(end)} 上完了`, { classEnd: end });
        }
    }

    // 下雨（ADR 0050）：这场雨开始后过一会儿；起床前、晚上 10 点后不发。一天一次（id 按天）
    if (enabled.has('weather') && input.rain?.day === dayText) {
        const time = Math.max(input.rain.start, wake) + pick(seed('weather'), 'at', minutes(RAIN_MIN));
        if (time < at(day, RAIN_UNTIL).getTime()) add('weather', time, `${hm(input.rain.start)} ${input.rain.forecast ? '预报要下雨' : '开始下雨'}`);
    }

    // 她那边的事（ADR 0057）：了结后过一会儿；一件一条（id 带事情的 id）
    if (enabled.has('news')) {
        for (const item of (input.news ?? []).filter(n => n.day === dayText)) {
            add('news', Math.max(item.at, wake) + pick(seed(`news ${item.id}`), 'at', minutes(NEWS_MIN)), item.what, { news: item }, `:${item.id}`);
        }
    }

    // 改约（ADR 0066）：约的那天起床后过一会儿；一件约一条（id 带约的 id），每件约只此一次
    if (enabled.has('reschedule')) {
        for (const item of (input.reschedules ?? []).filter(r => r.day === dayText)) {
            add('reschedule', Math.max(item.at, wake) + pick(seed(`reschedule ${item.id}`), 'at', minutes(NEWS_MIN)), `${item.time} 的约：${item.obstacle.text}`, { reschedule: item }, `:${item.id}`);
        }
    }

    // 零点要祝的那个晚上不另说睡前（10-05 模拟器：睡前先说了「生日快乐，提前说过了」，零点又祝一遍）
    if (enabled.has('bedtime') && !midnight.length) add('bedtime', at(day, BEDTIME_FROM).getTime() + pick(seed('bedtime'), 'at', minutes(BEDTIME_MIN)), '准备睡了');

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

/** 发送出错、但前几个气泡已经发出去了：他收到了，和发了一样算（占每天的上限、算「没回」）；一个都没发出去的不算 */
const partlySent = (r: ProactiveRecord) => r.result === 'failed' && Boolean(r.messageIds?.length);
export const counts = (r: ProactiveRecord) => r.result === 'sent' || r.result === 'dryRun' || partlySent(r);

/** 她的这一天里已经主动了几条（日子不算） */
export function usedOn(day: string, records: readonly ProactiveRecord[]): number {
    return records.filter(r => r.id.startsWith(`${day}:`) && r.occasion !== 'dates' && counts(r)).length;
}

/** 他最后一条消息之后，她主动发了几条（试运行时算试运行的记录，打开时算真发的） */
export function unansweredCount(input: Pick<ProactiveInput, 'history' | 'records' | 'mode'>): number {
    const lastUser = input.history.findLast(m => m.role === 'user');
    const since = lastUser ? Date.parse(lastUser.time) : -Infinity;
    const kind = input.mode === 'on' ? 'sent' : 'dryRun';
    return input.records.filter(r => (r.result === kind || (kind === 'sent' && partlySent(r))) && Date.parse(r.at) > since).length;
}

export interface Plan {
    /** 接下来要发的候选（这一天的，没有就看下一天的），按时间排 */
    upcoming: Candidate[];
    /** 这一天到点已经过了 GRACE_MS 还没记过的：错过了，不补 */
    missed: Candidate[];
    /** 这一天让给优先级更高的（剩下的条数不够） */
    yielded: Candidate[];
    /** 她主动发的他还没回、到了上限：除了日子都先不排，等他回 */
    paused?: string;
}

/**
 * 现在往后的计划：这一天还没记过、没错过的候选，按优先级留下剩下的条数（日子都留）；
 * 这一天没有了就看下一天（状态页显示「明天 09:52 早安」）。
 */
export function planFrom(now: number, input: ProactiveInput): Plan {
    const recorded = new Set(input.records.filter(r => !waitingRetry(r)).map(r => r.id));
    // 没连上模型、等着再试的：还是那个候选，时刻换成再试的时刻
    const retryAt = new Map(input.records.filter(waitingRetry).map(r => [r.id, Date.parse(r.retryAt!)]));
    const today = herDay(input.schedule, new Date(now));
    const missed: Candidate[] = [];
    const yielded: Candidate[] = [];
    const paused = unansweredCount(input) >= input.settings.unansweredMax ? '上一条主动消息他还没回，等他回了再排' : undefined;
    const result = (upcoming: Candidate[]): Plan => ({ upcoming, missed, yielded, ...(paused ? { paused } : {}) });
    for (const [offset, day] of [today, addDays(today, 1)].entries()) {
        const all = candidatesOn(day, input).filter(c => !recorded.has(c.id))
            .map(c => (retryAt.has(c.id) ? { ...c, at: retryAt.get(c.id)! } : c))
            .sort((a, b) => a.at - b.at);
        if (offset === 0) missed.push(...all.filter(c => c.at < now - GRACE_MS));
        const open = all.filter(c => c.at >= now - GRACE_MS);
        const left = paused ? 0 : Math.max(0, input.settings.dailyMax - usedOn(formatDate(day), input.records));
        // 同是「她那边的事」的，按事件类排（相机 > 作业写完 > 不舒服，ADR 0064 决策 5）
        const kindRank = (c: Candidate) => (c.news ? NEWS_KINDS.indexOf(c.news.kind) : 0);
        const byPriority = open.filter(c => c.occasion !== 'dates')
            .sort((a, b) => OCCASIONS.indexOf(a.occasion) - OCCASIONS.indexOf(b.occasion) || kindRank(a) - kindRank(b));
        const kept = new Set([...open.filter(c => c.occasion === 'dates'), ...byPriority.slice(0, left)]);
        if (offset === 0 && !paused) yielded.push(...byPriority.slice(left));
        const upcoming = open.filter(c => kept.has(c));
        if (upcoming.length) return result(upcoming);
    }
    return result([]);
}

/** 到点时还能不能发：不能就返回原因（记进记录和日志） */
export function blockReason(candidate: Candidate, now: number, input: ProactiveInput): string | undefined {
    const { schedule, history } = input;
    // 他刚说过想伤害自己的话（ADR 0068 决策 5）：普通的主动消息暂停；待跟进和重要的日子不受影响
    if (input.crisisPaused && candidate.occasion !== 'dates' && candidate.occasion !== 'follow_up') return CRISIS_PAUSE_REASON;
    const state = stateAt(schedule, new Date(now));
    if (state.activity.kind === 'sleep') return '她在睡觉';
    if (input.asleep?.(now)) return '她说过睡了';
    if (state.activity.kind === 'class') return '她在上课';
    const special = candidate.occasion === 'dates';
    const day = herDay(schedule, new Date(now));
    if (!special && now >= at(addDays(day, 1), NIGHT_FROM).getTime()) return '夜里了，不打扰';
    if (pendingMessages([...history]).length && !input.skip?.([...history])) return PENDING_REASON;
    const last = history.at(-1);
    const lastTime = last ? Date.parse(last.time) : undefined;
    if (special) return undefined;
    if (candidate.occasion === 'bedtime') {
        if (lastTime !== undefined && now - lastTime < BEDTIME_RECENT_MS) return '20 分钟内聊过';
    } else if (candidate.occasion === 'news' || candidate.occasion === 'reschedule') {
        if (lastTime !== undefined && now - lastTime < NEWS_RECENT_MS) return '正聊着，聊天里说';
    } else if (lastTime !== undefined && now - lastTime < RECENT_MS) {
        return '一小时内聊过';
    }
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
        case 'bedtime': {
            if (!userSince(wake)) return '今天没聊过';
            // 今晚谁说过晚安都算（10-05 模拟器：他说了「我先睡了，晚安」，她回的话里没有这几个词，只看最后一句就又发了一条）
            const evening = at(day, EVENING_FROM).getTime();
            if (history.some(m => Date.parse(m.time) >= evening && GOODNIGHT.test(m.content))) return '已经道过晚安';
            break;
        }
        case 'quiet':
            if (lastTime === undefined || now - lastTime < QUIET_MS) return '没到 8 小时';
            break;
        case 'follow_up':
            if (!input.followUps?.some(f => f.id === candidate.followUp!.item.id)) return '那件事已经了结';
            break;
        case 'weather':
            // 按预报排的：到点没在下就不发（预报不准）
            if (!input.rainingNow?.(now)) return '没在下雨';
            break;
        case 'reschedule': {
            // 到点再核一遍：约还在、障碍还在、约还没到快出门的时候；那之后聊天里已经说到这件约了就不单发
            const item = input.reschedules?.find(r => r.id === candidate.reschedule!.id && r.day === candidate.day);
            if (!item) return '约没了，或者那个障碍没了';
            if (now >= item.start - 15 * MIN) return '快到约好的时间了';
            if (mentionsMeetup(history.filter(m => Date.parse(m.time) >= item.at))) return '聊天里已经说到这件约了';
            break;
        }
        case 'news': {
            const item = input.news?.find(n => n.id === candidate.news!.id && n.day === candidate.day);
            if (!item) return '那件事没发生';
            // 那之后聊过：聊天里多半已经说了（状态行里有），不再单发一条
            if (history.some(m => Date.parse(m.time) >= item.at)) return '那之后聊过了';
            break;
        }
    }
    return undefined;
}

/** 主动发的最多几条气泡 */
export const MAX_PROACTIVE_BUBBLES = 2;
/** 有没回的消息时不主动的原因（计划器和回复器都用） */
export const PENDING_REASON = '有没回的消息，回复就好';
export const CRISIS_PAUSE_REASON = '他最近说过想伤害自己的话，普通的主动消息先暂停';

/** 顺带说没说成的事的时机：问候、找他说话的这几种（日子、下雨、待跟进各有要说的那一件） */
const CARRIES_NEWS: ReadonlySet<Occasion> = new Set(['morning', 'after_class', 'quiet', 'bedtime']);

/**
 * 她那边的事没说成（ADR 0057 调整，10-11）：这一天了结了、那条主动没发出去（没连上模型、错过了、没排上）、
 * 那之后两人也没说过话——这一天后面的主动顺带说。10-11 下午断网，买到相机那条没发成，晚上的睡前只道晚安。
 * 发出去了、还等着再试的不算；那之后聊过的不算（聊天里多半说了，和 blockReason 一样）
 */
export function untoldNews(candidate: Candidate, now: number, input: Pick<ProactiveInput, 'news' | 'records' | 'history'>): NewsItem[] {
    if (!CARRIES_NEWS.has(candidate.occasion)) return [];
    return (input.news ?? []).filter(item => item.day === candidate.day && item.at <= now
        && !input.records.some(r => r.id === `${item.day}:news:${item.id}` && (counts(r) || waitingRetry(r)))
        && !input.history.some(m => Date.parse(m.time) >= item.at));
}

/** 提示词里的说明（ADR 0011 决策 3）：这次是你主动找他、为什么。userName 是称呼（{{user}}）；untold：没说成的事（untoldNews） */
export function occasionNote(candidate: Candidate, userName: string, untold: readonly NewsItem[] = []): string {
    const names = candidate.importantDays?.map(d => d.name).join('、') ?? '';
    const followUp = candidate.followUp;
    const why: Record<Occasion, () => string> = {
        morning: () => `你起床没多久，跟${userName}说早安${candidate.today ? `；${userName}今天${candidate.today.join('、')}，可以说句加油` : ''}`,
        after_class: () => `你今天的课上完了，跟${userName}说一声`,
        // 他在哪看「你现在」那一行：同在学校时他那边也在下，不问「你那边下没下」（ADR 0050 验证：3 次里问了 2 次）
        weather: () => `你这边下雨了（看「你那边」的天气），想起${userName}：问一句他在干嘛、带没带伞，或者说说你这边的雨；他在哪看「你现在」那一行，跟你在一个地方的话他那边也在下；就说这一件`,
        bedtime: () => `时间不早了，跟${userName}道个晚安`,
        // 只给事实和方向，不给台词（ADR 0036 调整（2026-10-10 夜））
        // 每一类都写死：只说这一件、不要他回应或关心；不舒服不是求安抚（ADR 0064 决策 4，调研 D 块把「求安抚」类触发列为与目标冲突）
        // 改约（ADR 0066 决策 3）：只说原因（那一条障碍事实）和提议改个时间；不过度道歉、不要他回应、不抱怨（0011 调整 5）
        reschedule: () => `你和${userName}今天 ${candidate.reschedule!.time} 约好了${candidate.reschedule!.what}${candidate.reschedule!.where ? `（${candidate.reschedule!.where}）` : ''}，但今天${candidate.reschedule!.obstacle.text}：`
            + '想跟他说一声，问问能不能改个时间；原因只说这一条（看「你那边」和上面的事实），别编别的，别过分道歉，不抱怨他',
        news: () => ({
            camera: () => `你刚${candidate.news!.what}，想第一时间告诉${userName}：说说这件事（看「你那边」那一行），就说这一件；那一行里没写的细节不编`,
            homework_done: () => `你刚${candidate.news!.what}，想跟${userName}说一声：就说这一件（看「你那边」那一行里的作业），不要他回应或夸你；那一行里没写的细节不编`,
            // 闺蜜的约变了（ADR 0061）：说的是她得知的这件事（谁、约的什么、变成了什么、她说的原因）；不是求安慰，也不借机抱怨她、不编她没说的原因
            friend_changed: () => `你刚得知${candidate.news!.what}，想跟${userName}说一声：就说这一件（看「你那边」那一行里的约），不要他回应或安慰你；那一行里没写的原因和细节不编`,
            // 闺蜜病了（头一天）：她从对方那里得知；只说这一件，不借机求安慰、不编病情
            friend_sick: () => `你刚得知${candidate.news!.what}，想跟${userName}说一声：就说这一件（看「你那边」那一行里的朋友），不要他回应或安慰你；病得怎么样、有没有去看、你做了什么，那一行里没写的不编`,
            unwell: () => `你今天${candidate.news!.what}，想跟${userName}说一声：只是告诉他，不是要他哄你、关心你，也不要他回应；说到哪一步照「你的身体」那一行，没写的细节不编`,
        })[candidate.news!.kind](),
        // 旧项目的教训（ADR 0013 决策 2）：分享「刚看到的」会编出一个具体的视频、帖子，对方要链接时给不出来
        quiet: () => `你们大半天没说话了，你想找${userName}说两句：说说你自己在干嘛（照「你现在」那一行说；不提刚刷到的视频、帖子、新闻，` +
            `对方要链接你给不出来），或者问问对方在忙什么（对方可能在忙）`,
        follow_up: () => `${followUp!.atMorning ? `你起床没多久，跟${userName}说早安，顺便` : ''}问问${userName}${followUp!.when}的${followUp!.item.what}怎么样了（${userName}之前跟你说过）`,
        dates: () => (candidate.id.endsWith(':midnight')
            ? `零点了，今天是${names}，你一直记着，第一时间跟${userName}说`
            : `今天是${names}。你起床没多久，跟${userName}说早安，也提一句这个日子`),
    };
    // 10-05 模拟器：冷场 3 次有 1 次「都不带搭理我的」，早安 3 次有 2 次「我都起来了你还没消息」「都不吭声」。
    // 人设早就去掉了算「不回消息」的账（persona.yml heart.fear 的说明），这里每种时机都说一遍
    // 没说成的事：只给事实和方向（ADR 0036 调整（2026-10-10 夜）），不给台词、不给没说成的原因（她那边的人不知道断网）
    const told = untold.length ? `；你今天${untold.map(n => n.what).join('、')}，还没跟${userName}说过，这次一起说（看「你那边」那一行，没写的细节不编）` : '';
    return `[这次是你主动找${userName}：${why[candidate.occasion]()}${told}。只发一两句，像平时随手发的消息；不抱怨对方没找你、没回你。]`;
}

/** 主动找他时召回长期记忆想知道什么（ADR 0012 决策 1 第 7 条） */
export function recallTopic(candidate: Candidate, userName: string): string {
    const recent = `${userName}最近在忙什么、身体和心情怎么样、这几天有什么安排或约好的事`;
    if (candidate.occasion === 'dates') return `${candidate.importantDays!.map(d => d.name).join('、')}；${recent}`;
    if (candidate.occasion === 'follow_up') return `${userName}${candidate.followUp!.when}的${candidate.followUp!.item.what}；${recent}`;
    return recent;
}

/** 日志、状态页里的说法：「早安（起床后 12 分钟）」 */
export const OCCASION_LABELS: Record<Occasion, string> = {
    dates: '重要的日子', reschedule: '改约', news: '她那边的事', follow_up: '待跟进的事', weather: '下雨', morning: '早安', after_class: '下课', quiet: '冷场', bedtime: '睡前',
};

export function candidateLabel(candidate: Candidate): string {
    // 她那边的事写上事件类和事情的 id（ADR 0064 决策 7），日志里能指到来源
    const kind = candidate.news ? `[${candidate.news.kind} ${candidate.news.id}]` : '';
    // 待跟进的事是由他说过的话提炼出来的：标签（日志、状态页）里的那几个字随敏感调试开关走，关着只剩字数
    const reason = candidate.followUp ? `问${candidate.followUp.when}的${logBody(candidate.followUp.item.what)}` : candidate.reason;
    return `${OCCASION_LABELS[candidate.occasion]}${kind}（${reason}）`;
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
    if (o.newsKinds !== undefined && !(Array.isArray(o.newsKinds) && o.newsKinds.every(x => NEWS_KINDS.includes(x as NewsKind)))) fail(`.newsKinds 应为 ${NEWS_KINDS.join(' / ')} 组成的数组`);
    return {
        occasions: o.occasions as Occasion[], dailyMax: count('dailyMax'), unansweredMax: count('unansweredMax'),
        ...(o.newsKinds !== undefined ? { newsKinds: o.newsKinds as NewsKind[] } : {}),
    };
}
