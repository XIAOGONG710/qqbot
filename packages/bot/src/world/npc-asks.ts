// 闺蜜的约（ADR 0061）：对方主动约她、迟到、改时间、临时取消；她按自己那一刻的安排答应或推掉。
// - 和 npc.ts 一样全按「日期 + 人 + 名目」取哈希：同一天对所有人一样，重启、重放一样，不存状态，不问模型。
// - 约的结果在约之前就定好（按时 / 迟到 / 改到晚一点 / 临时取消），理由从对方自己的日子里来（病了、忙、回家，npc.ts）或者配置里的几句。
// - 这一版只是事实层（纯函数 + 审计 + 预览，sim/asks-preview.ts）：没接进世界推进、事件账、状态行和提示词（ADR 0061 决策 5「先影子」）。
// - 只写事实，不写台词、不写情绪（ADR 0021 决策 3）。

import { classesOn, formatDate, type Schedule } from '../life/schedule.ts';
import { localDate } from '../local-date.ts';
import { MAX_NPC_MONTHLY_SPANS, npcStates, unit, type NpcLife, type NpcStateKind } from './npc.ts';

/** 约在一天的哪一段：午饭、晚饭、晚上、周末下午 */
export type AskSlot = 'lunch' | 'dinner' | 'evening' | 'weekend';

export interface AskKind {
    id: string;
    /** 约的事（不带人名）：「下课一起去食堂吃饭」；整句是「<名字>约你<what>」 */
    what: string;
    /** 在一起的那段时间状态行怎么说，{person} 换成名字 */
    doing: string;
    slot: AskSlot;
    /** 哪些日子会约：上课的日子 / 周末 / 都行（放假、学期外不约：那时她不在学校） */
    when: 'class_day' | 'weekend' | 'any';
    /** 这件事大约多久 */
    minutes: number;
    where?: string;
    /** 约的就是她那天的这顿饭：开始时刻跟着世界里排好的那顿走（anchors.meal 给了才生效；没给就落在 slot 那一段里） */
    anchor?: 'lunch' | 'dinner';
}

/** 世界里已经排好的事，约要对上它们（world.ts 传进来；预览、测试可以不传） */
export interface AskAnchors {
    meal?: (kind: 'lunch' | 'dinner', day: Date) => { start: Date; end: Date } | undefined;
}

/** 变卦的理由；private：对方自己的私事（身体、家里），只在最亲的档位、被问到才说（ADR 0020，ADR 0061 决策 4） */
export interface AskReason { text: string; private?: boolean }

export interface AsksConfig {
    /** 平均每月几次约 */
    perMonth: number;
    kinds: AskKind[];
    /** 前一晚说的占比；其余是当天上午说的 */
    dayBefore: number;
    late: { chance: number; minutes: [number, number]; reasons: AskReason[] };
    moved: { chance: number; shiftMinutes: [number, number]; reasons: AskReason[] };
    cancelled: { chance: number; reasons: AskReason[] };
}

export type AskOutcome = 'on_time' | 'late' | 'moved' | 'cancelled';

export interface NpcAsk {
    /** `<日期>:<人>:<名目>`，稳定 */
    id: string;
    person: string;
    name: string;
    kind: string;
    /** 整句：「<名字>约你<what>」 */
    text: string;
    what: string;
    /** 在一起的那段时间状态行怎么说 */
    doing: string;
    /** 约的那天 */
    day: string;
    /** 对方什么时候说的 */
    askedAt: Date;
    /** 原定开始 */
    start: Date;
    minutes: number;
    where?: string;
    outcome: AskOutcome;
    /** late：实际到的时刻；moved：改到的时刻 */
    actualStart?: Date;
    /** 迟到 / 改约 / 取消的理由 */
    reason?: AskReason;
    /** 理由来自对方自己的日子（新发的病、忙、回家），不是配置里随机挑的 */
    fromState?: NpcStateKind;
}

/** FriendDate 的可协调部分；不依赖 world.ts，避免把事实层与展示层形成运行时循环。 */
export interface NpcDateReservation {
    id: string;
    askedAt: Date;
    start: Date;
    minutes: number;
    outcome: AskOutcome;
    actualStart?: Date;
    knownAt?: Date;
    declined?: string;
    declinedAt?: Date;
    held: boolean;
}

/**
 * 已答应的朋友约也占时间。按邀请/变卦被知道的时刻重放，先承诺的优先，同刻以稳定 ID 打平。
 * 取消在通知到达后才释放旧时段；改约或迟到撞上已有承诺时记成她当时推掉，不能只从结果中删去。
 */
export function coordinateNpcDates<T extends NpcDateReservation>(dates: readonly T[]): T[] {
    const copies = dates.map(date => ({ ...date }));
    const moments = new Map<number, { asks: T[]; changes: T[] }>();
    const ids = new Set<string>();
    const add = (at: Date, kind: 'asks' | 'changes', date: T) => {
        if (!Number.isFinite(at.getTime())) throw new RangeError('朋友约定的时刻不合法');
        const moment = moments.get(at.getTime()) ?? { asks: [], changes: [] };
        moment[kind].push(date);
        moments.set(at.getTime(), moment);
    };
    for (const date of copies) {
        if (!date.id || ids.has(date.id) || !Number.isFinite(date.start.getTime()) || !Number.isInteger(date.minutes) || date.minutes <= 0
            || (date.actualStart && !Number.isFinite(date.actualStart.getTime()))) throw new RangeError('朋友约定的身份或时段不合法');
        ids.add(date.id);
        add(date.askedAt, 'asks', date);
        if (date.knownAt) add(date.knownAt, 'changes', date);
        if (date.declinedAt && date.declinedAt.getTime() !== date.knownAt?.getTime() && date.declinedAt > date.askedAt) add(date.declinedAt, 'changes', date);
    }
    const reserved = new Map<string, { start: number; end: number }>();
    const priority = (a: T, b: T) => a.askedAt.getTime() - b.askedAt.getTime() || a.id.localeCompare(b.id);
    const declinedBy = (date: T, at: number) => Boolean(date.declined && (!date.declinedAt || date.declinedAt.getTime() <= at));
    const reserve = (date: T, start: Date, at: number, changed: boolean) => {
        const from = start.getTime(); const to = from + date.minutes * 60_000;
        const clash = [...reserved.values()].some(span => span.start < to && from < span.end);
        if (clash) {
            date.declined = changed ? '改时间后和先答应的约撞了' : '那会儿已经答应别的约了';
            date.declinedAt = new Date(at);
            date.held = false;
        } else reserved.set(date.id, { start: from, end: to });
    };
    for (const [at, moment] of [...moments].sort(([a], [b]) => a - b)) {
        const changing = moment.changes.filter(date => reserved.has(date.id)).sort(priority);
        // 同时改约先统一释放旧时段，再按承诺优先级分配，避免处理顺序制造虚假的冲突。
        for (const date of changing) reserved.delete(date.id);
        for (const date of changing) {
            if (declinedBy(date, at) || date.outcome === 'cancelled') continue;
            reserve(date, date.actualStart ?? date.start, at, true);
        }
        for (const date of moment.asks.sort(priority)) {
            if (declinedBy(date, at) || (date.outcome === 'cancelled' && date.knownAt && date.knownAt.getTime() <= at)) continue;
            const known = date.knownAt && date.knownAt.getTime() <= at;
            reserve(date, known && date.actualStart ? date.actualStart : date.start, at, false);
        }
    }
    return copies.sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
}

/** 约在哪一段：开始时刻可以落在 [from, to] 里（十分钟一档，且和课前后各留一点） */
const SLOTS: Record<AskSlot, [string, string]> = {
    lunch: ['11:30', '13:00'],
    dinner: ['17:00', '18:30'],
    evening: ['19:00', '20:30'],
    weekend: ['13:30', '16:00'],
};
/** 和上课的前后各留这么久 */
const CLASS_BUFFER_MIN = 10;
/** 当天上午说的，最早几点说（再早她多半没醒） */
const MORNING_ASK_FROM = 9 * 60;
/** 当天说的，至少提前这么久 */
const MIN_LEAD_MIN = 90;
/** 前一晚说的在这个范围（分钟，当天零点起算前一天的 20:00 起） */
const EVENING_ASK_FROM = 20 * 60;
const EVENING_ASK_SPREAD = 120;
/** 改到晚一点最晚到几点结束，再晚就不了了之 */
const LATEST_END = 22 * 60 + 30;

/** 卡上还没有这一块（world.yml 的 asks 另一步再加）：先按人的 id 放默认。数字是可改的设定（ADR 0061 确认记录） */
export const DEFAULT_ASKS: Record<string, AsksConfig> = {
    su_yutong: {
        perMonth: 4,
        dayBefore: 0.5,
        kinds: [
            { id: 'canteen', what: '下课一起去食堂吃饭', doing: '在食堂和{person}吃午饭', slot: 'lunch', when: 'class_day', minutes: 45, anchor: 'lunch' },
            { id: 'dinner', what: '一起去吃晚饭', doing: '和{person}一起吃晚饭', slot: 'dinner', when: 'class_day', minutes: 50, anchor: 'dinner' },
            { id: 'library', what: '一起去图书馆', doing: '在图书馆和{person}一起自习', slot: 'evening', when: 'class_day', minutes: 90, where: '图书馆' },
            { id: 'stroll', what: '出去转转', doing: '和{person}出去转转', slot: 'weekend', when: 'weekend', minutes: 150 },
        ],
        late: { chance: 0.15, minutes: [5, 20], reasons: [{ text: '下课被老师拖堂了' }, { text: '出门晚了' }, { text: '路上碰到认识的人聊了几句' }] },
        moved: { chance: 0.1, shiftMinutes: [60, 150], reasons: [{ text: '临时要先去办件事' }, { text: '作业还差一点想先弄完' }, { text: '睡过头了' }] },
        cancelled: { chance: 0.05, reasons: [{ text: '临时被老师叫去帮忙' }, { text: '突然肚子疼', private: true }, { text: '家里有点事', private: true }] },
    },
    chen_jianing: {
        perMonth: 3,
        dayBefore: 0.7,
        kinds: [
            { id: 'video', what: '微信视频', doing: '在和{person}微信视频', slot: 'evening', when: 'any', minutes: 40 },
        ],
        late: { chance: 0.15, minutes: [5, 25], reasons: [{ text: '她那边宿舍有点吵，找地方' }, { text: '刚忙完' }] },
        moved: { chance: 0.15, shiftMinutes: [60, 120], reasons: [{ text: '她那边临时有事' }, { text: '她作业还没弄完' }] },
        cancelled: { chance: 0.05, reasons: [{ text: '她那边临时有事，改天' }, { text: '她睡着了' }] },
    },
};

export interface AskPerson { id: string; name: string; life?: NpcLife }

const at =(day: Date, minutes: number) => localDate(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
const addDays = (day: Date, n: number) => localDate(day.getFullYear(), day.getMonth(), day.getDate() + n);
const clock = (text: string) => { const [h, m] = text.split(':').map(Number); return h! * 60 + m!; };
const holidayOn = (schedule: Schedule, day: Date) => { const date = formatDate(day); return schedule.holidays.some(h => h.start <= date && date <= h.end); };

/** 这一天、这个名目有没有合适的开始时刻：落在这一段里，且和课前后各留一点；有就按哈希挑一个（十分钟一档） */
function startFor(kind: AskKind, schedule: Schedule, day: Date, key: string, anchors?: AskAnchors): Date | undefined {
    const { lessons, outsideSemester } = classesOn(schedule, day);
    if (outsideSemester || holidayOn(schedule, day)) return undefined;
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    if (kind.when === 'class_day' && !lessons.length) return undefined;
    if (kind.when === 'weekend' && !weekend) return undefined;
    // 约的是她那天的这顿饭：跟着世界里排好的那顿（和课撞的那顿世界里本来就没有）
    if (kind.anchor && anchors?.meal) return anchors.meal(kind.anchor, day)?.start;
    const [from, to] = SLOTS[kind.slot].map(clock) as [number, number];
    const starts: number[] = [];
    for (let t = from; t <= to; t += 10) {
        const clash = lessons.some(l => {
            const ls = l.start.getHours() * 60 + l.start.getMinutes() - CLASS_BUFFER_MIN;
            const le = l.end.getHours() * 60 + l.end.getMinutes() + CLASS_BUFFER_MIN;
            return t < le && t + kind.minutes > ls;
        });
        if (!clash) starts.push(t);
    }
    if (!starts.length) return undefined;
    return at(day, starts[Math.floor(unit(`${key} start`) * starts.length)]!);
}

const pick = <T>(list: readonly T[], key: string): T => list[Math.floor(unit(key) * list.length)]!;

const BLOCKING: readonly NpcStateKind[] = ['sick', 'busy', 'home'];
const stateOf = (person: AskPerson, schedule: Schedule, day: Date) => npcStates(person.id, person.life, schedule, day).find(s => BLOCKING.includes(s.kind));

/** 这个人在 first 那个月里发起的约（约的那天都落在这个月） */
function monthAsks(person: AskPerson, config: AsksConfig, schedule: Schedule, first: Date, anchors?: AskAnchors): NpcAsk[] {
    if (!Number.isFinite(config.perMonth) || config.perMonth < 0 || config.perMonth > MAX_NPC_MONTHLY_SPANS) throw new RangeError(`NPC每月邀请次数应为 0–${MAX_NPC_MONTHLY_SPANS} 内的有限数`);
    const month = formatDate(first).slice(0, 7);
    const length = localDate(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const count = Math.floor(config.perMonth) + (unit(`${month} ${person.id} ask extra`) < config.perMonth % 1 ? 1 : 0);
    const taken = new Set<string>();
    const asks: NpcAsk[] = [];
    for (let k = 0; k < count; k++) {
        const key = `${month} ${person.id} ask ${k}`;
        const kind = pick(config.kinds, `${key} kind`);
        const startIndex = Math.floor(unit(`${key} day`) * length);
        for (let step = 0; step < length; step++) {
            const day = addDays(first, (startIndex + step) % length);
            const date = formatDate(day);
            if (taken.has(date)) continue;
            const start = startFor(kind, schedule, day, `${key} ${date}`, anchors);
            if (!start) continue;
            const dayBefore = unit(`${key} lead`) < config.dayBefore;
            const askedDay = dayBefore ? addDays(day, -1) : day;
            // 对方自己正病着、忙着、在家的时候不会发起约
            if (stateOf(person, schedule, askedDay)) continue;
            const askedMinutes = dayBefore
                ? EVENING_ASK_FROM + Math.floor(unit(`${key} asked`) * EVENING_ASK_SPREAD)
                : Math.min(MORNING_ASK_FROM + Math.floor(unit(`${key} asked`) * 90), start.getHours() * 60 + start.getMinutes() - MIN_LEAD_MIN);
            taken.add(date);
            asks.push(settle({
                id: `${date}:${person.id}:${kind.id}`, person: person.id, name: person.name, kind: kind.id,
                text: `${person.name}约你${kind.what}`, what: kind.what, doing: kind.doing.replace('{person}', person.name), day: date, askedAt: at(askedDay, askedMinutes), start, minutes: kind.minutes,
                ...(kind.where ? { where: kind.where } : {}), outcome: 'on_time',
            }, person, config, schedule, key));
            break;
        }
    }
    return asks;
}

/** 定结果：对方那天新发的病、忙、回家 → 取消（理由是那个状态）；否则按占比抽：取消 / 改到晚一点 / 迟到 / 按时 */
function settle(ask: NpcAsk, person: AskPerson, config: AsksConfig, schedule: Schedule, key: string): NpcAsk {
    const state = stateOf(person, schedule, new Date(`${ask.day}T00:00`));
    if (state) {
        const text = state.kind === 'sick' ? '感冒了' : state.kind === 'busy' ? `这几天${state.label}` : '回家了';
        return { ...ask, outcome: 'cancelled', reason: { text, ...(state.kind === 'sick' ? { private: true } : {}) }, fromState: state.kind };
    }
    const roll = unit(`${key} outcome`);
    const cancelled = config.cancelled.chance;
    const moved = cancelled + config.moved.chance;
    const late = moved + config.late.chance;
    const end = (start: Date) => start.getHours() * 60 + start.getMinutes() + ask.minutes;
    if (roll < cancelled) return { ...ask, outcome: 'cancelled', reason: pick(config.cancelled.reasons, `${key} cancelled reason`) };
    if (roll < moved) {
        const [lo, hi] = config.moved.shiftMinutes;
        // 改到的时刻要在 LATEST_END 之前结束；原定就已经很晚的，没得往后挪，按原定来（不当成取消，免得把取消的占比抬高）
        const room = Math.floor((LATEST_END - end(ask.start)) / 10) * 10;
        const top = Math.min(hi, room);
        if (top < lo) return ask;
        const shift = lo + 10 * Math.floor(unit(`${key} shift`) * ((top - lo) / 10 + 1));
        return { ...ask, outcome: 'moved', actualStart: new Date(ask.start.getTime() + shift * 60_000), reason: pick(config.moved.reasons, `${key} moved reason`) };
    }
    if (roll < late) {
        const [lo, hi] = config.late.minutes;
        const minutes = lo + Math.floor(unit(`${key} late`) * (hi - lo + 1));
        return { ...ask, outcome: 'late', actualStart: new Date(ask.start.getTime() + minutes * 60_000), reason: pick(config.late.reasons, `${key} late reason`) };
    }
    return ask;
}

/** 约的那天是 day 的所有约（按原定开始排）；没写配置的人没有约 */
export function npcAsksOn(people: readonly AskPerson[], schedule: Schedule, day: Date, configs: Record<string, AsksConfig> = DEFAULT_ASKS, anchors?: AskAnchors): NpcAsk[] {
    const first = localDate(day.getFullYear(), day.getMonth(), 1);
    const date = formatDate(day);
    return people.flatMap(person => (configs[person.id] ? monthAsks(person, configs[person.id]!, schedule, first, anchors) : []))
        .filter(ask => ask.day === date)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** 一段日子里的所有约（预览、审计用） */
export function npcAsksBetween(people: readonly AskPerson[], schedule: Schedule, from: Date, to: Date, configs: Record<string, AsksConfig> = DEFAULT_ASKS, anchors?: AskAnchors): NpcAsk[] {
    const out: NpcAsk[] = [];
    for (let day = from; day.getTime() <= to.getTime(); day = addDays(day, 1)) out.push(...npcAsksOn(people, schedule, day, configs, anchors));
    return out;
}

// ---------- 她答不答应 ----------

/** 她那一刻知道的安排：课、和他约好的见面、最近一份没写完的作业的截止、身上不舒服 */
export interface AskFacts {
    classes: { start: Date; end: Date }[];
    meetups: { start: Date; end: Date }[];
    homeworkDue?: Date;
    unwell?: boolean;
}

export type AskVerdict = { accept: true } | { accept: false; because: 'meetup' | 'class' | 'unwell' | 'homework'; reason: string };

/** 作业还差多久到期算「快交了」，约晚上、周末时推掉 */
const HOMEWORK_NEAR_MS = 48 * 3600_000;

/**
 * 规则判，不问模型（ADR 0061 决策 2）。窗口默认是原定的那段；迟到、改约之后再判一次时传新的。
 * 顺序：和他的见面 > 课 > 身上不舒服 > 作业快交了（吃饭不推：人总要吃饭）。没撞上就答应：这一版没有「懒得去」
 */
export function judgeAsk(ask: NpcAsk, facts: AskFacts, window?: { start: Date; end: Date }): AskVerdict {
    const start = window?.start ?? ask.start;
    const end = window?.end ?? new Date(start.getTime() + ask.minutes * 60_000);
    const overlaps = (x: { start: Date; end: Date }) => x.start < end && start < x.end;
    if (facts.meetups.some(overlaps)) return { accept: false, because: 'meetup', reason: '跟他约好了' };
    if (facts.classes.some(overlaps)) return { accept: false, because: 'class', reason: '那会儿有课' };
    if (facts.unwell) return { accept: false, because: 'unwell', reason: '身上不舒服' };
    const meal = ask.kind === 'canteen' || ask.kind === 'dinner';
    const left = facts.homeworkDue ? facts.homeworkDue.getTime() - start.getTime() : undefined;
    if (!meal && left !== undefined && left > 0 && left < HOMEWORK_NEAR_MS) return { accept: false, because: 'homework', reason: '作业还没写完' };
    return { accept: true };
}

/** 日志、预览里的一句 */
export function describeAsk(ask: NpcAsk): string {
    const time = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const base = `${ask.text}（${time(ask.start)}${ask.where ? `，${ask.where}` : ''}）`;
    switch (ask.outcome) {
        case 'on_time': return `${base}，按时`;
        case 'late': return `${base}，迟到到 ${time(ask.actualStart!)}：${ask.reason!.text}`;
        case 'moved': return `${base}，改到 ${time(ask.actualStart!)}：${ask.reason!.text}`;
        case 'cancelled': return `${base}，取消：${ask.reason!.text}`;
    }
}
