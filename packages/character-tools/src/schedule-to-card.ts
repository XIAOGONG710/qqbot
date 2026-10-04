// 作息（ADR 0007 决策 1）：legacy/schedule.toml + timetable.toml + tiers.toml 的 [schedule] → 每一档角色卡的 extensions.qqbot.schedule。
// 运行时按它算她现在在干什么、什么时候看到消息（packages/bot/src/schedule.ts）。
// 按档位裁剪：课名、教室、课型名只给 course_detail 里的档位；空闲活动可以只给部分档位；地点和「他在哪」按档位写不同说法。

import { getString, getTable, isTable, type Table } from './legacy.ts';
import type { CardSchedule, CourseKind } from './st-format.ts';

const KINDS: CourseKind[] = ['hard', 'machine', 'water', 'pe'];
const WINDOWS = ['morning', 'afternoon', 'evening'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** tiers.toml 的 [schedule]，档位代号已解开成档位名 */
export interface ScheduleConfig {
    courseDetail: Set<string>;
    kinds: Record<CourseKind, { label: string; seeAfterMin?: [number, number]; maxBubbles?: number }>;
    /** 空闲活动原文 → 能看到的档位（没列的所有档位都能看到） */
    freeOnly: Map<string, Set<string>>;
    /** 平时（上学期间）她在哪：按档位 */
    where: Map<string, string>;
    /** 假期名 → 她在哪（按档位）、他在哪 */
    holidays: Map<string, { where: Map<string, string>; partner?: string }>;
    /** 上学期间他在哪 */
    partner?: string;
    /** 「他在哪」给哪些档位 */
    partnerTiers: Set<string>;
    /** 调休补课：日期 → 补星期几（1–7，0 = 没课），覆盖 timetable.toml 的 as_day */
    makeup: Map<string, number>;
}

type Decode = (codes: string, at: string) => Set<string>;

export function parseScheduleConfig(toml: Table, decode: Decode, tierNames: string[]): ScheduleConfig {
    const where = 'tiers.toml schedule';
    const s = getTable(toml, 'schedule', 'tiers.toml');
    const kindsTable = getTable(s, 'kinds', where);
    const kinds = Object.fromEntries(KINDS.map(kind => {
        const k = getTable(kindsTable, kind, `${where}.kinds`);
        const at = `${where}.kinds.${kind}`;
        const see = k.see_after;
        if (see !== undefined && !(Array.isArray(see) && see.length === 2 && see.every(n => typeof n === 'number' && n >= 0) && see[0] <= see[1])) {
            throw new Error(`${at}.see_after 应为 [最少分钟, 最多分钟]`);
        }
        const max = k.max_bubbles;
        if (max !== undefined && !(Number.isInteger(max) && (max as number) >= 1)) throw new Error(`${at}.max_bubbles 应为正整数`);
        return [kind, { label: getString(k, 'label', at), seeAfterMin: see as [number, number] | undefined, maxBubbles: max as number | undefined }];
    })) as ScheduleConfig['kinds'];
    for (const key of Object.keys(kindsTable)) if (!KINDS.includes(key as CourseKind)) throw new Error(`${where}.kinds.${key}：没有这个课型`);

    // { "BFGK" = "…", "CSU" = "…" } → 档位名 → 说法；每个档位恰好一种说法
    const byTier = (table: Table, at: string): Map<string, string> => {
        const map = new Map<string, string>();
        for (const codes of Object.keys(table)) {
            for (const name of decode(codes, at)) {
                if (map.has(name)) throw new Error(`${at}：档位 ${name} 出现了两次`);
                map.set(name, getString(table, codes, at));
            }
        }
        const missing = tierNames.filter(name => !map.has(name));
        if (missing.length) throw new Error(`${at}：缺少档位 ${missing.join('、')}`);
        return map;
    };

    const freeOnlyTable = s.free_only === undefined ? {} : getTable(s, 'free_only', where);
    const holidaysTable = s.holiday === undefined ? {} : getTable(s, 'holiday', where);
    const holidays = new Map(Object.keys(holidaysTable).map(name => {
        const h = getTable(holidaysTable, name, `${where}.holiday`);
        const at = `${where}.holiday."${name}"`;
        return [name, {
            where: byTier(getTable(h, 'where', at), `${at}.where`),
            partner: h.partner === undefined ? undefined : getString(h, 'partner', at),
        }];
    }));
    const makeupTable = s.makeup === undefined ? {} : getTable(s, 'makeup', where);
    const makeup = new Map(Object.entries(makeupTable).map(([date, day]) => {
        if (!DATE.test(date) || !Number.isInteger(day) || (day as number) < 0 || (day as number) > 7) {
            throw new Error(`${where}.makeup："${date}" 应为日期 = 星期几（1–7，0 = 没课）`);
        }
        return [date, day as number];
    }));

    return {
        courseDetail: decode(getString(s, 'course_detail', where), `${where}.course_detail`),
        kinds,
        freeOnly: new Map(Object.keys(freeOnlyTable).map(text => [text, decode(getString(freeOnlyTable, text, `${where}.free_only`), `${where}.free_only`)])),
        where: byTier(getTable(s, 'where', where), `${where}.where`),
        holidays,
        partner: s.partner === undefined ? undefined : getString(s, 'partner', where),
        partnerTiers: s.partner_tiers === undefined ? new Set() : decode(getString(s, 'partner_tiers', where), `${where}.partner_tiers`),
        makeup,
    };
}

/** 一个档位的作息：legacy 的作息、课表按 [schedule] 裁剪 */
export function scheduleForTier(scheduleToml: Table, timetableToml: Table, config: ScheduleConfig, tier: string): CardSchedule {
    // 睡觉：schedule.toml 里 active = false 的那一段；结束时间必须就是平时的起床时间
    const segments = scheduleToml.schedule && isTable(scheduleToml.schedule) ? scheduleToml.schedule.segments : undefined;
    if (!Array.isArray(segments)) throw new Error('schedule.toml 缺少 [[schedule.segments]]');
    const sleeping = segments.filter(seg => isTable(seg) && seg.active === false);
    if (sleeping.length !== 1) throw new Error(`schedule.toml 应恰好有一段 active = false（睡觉），现在有 ${sleeping.length} 段`);
    const [sleep = '', sleepEnd = ''] = getString(sleeping[0] as Table, 'hours', 'schedule.segments').split('-');

    const wakeup = getTable(timetableToml, 'wakeup', 'timetable.toml');
    const wake = { early: time(getString(wakeup, 'early', 'timetable.wakeup')), lazy: time(getString(wakeup, 'lazy', 'timetable.wakeup')) };
    if (time(sleepEnd) !== wake.lazy) throw new Error(`schedule.toml 睡到 ${sleepEnd}，timetable.toml 平时 ${wake.lazy} 起，对不上`);

    const periodsTable = getTable(timetableToml, 'periods', 'timetable.toml');
    const periods = Object.fromEntries(Object.keys(periodsTable).map(slot => {
        const [start = '', end = ''] = getString(periodsTable, slot, 'timetable.periods').split('-');
        return [slot, { start: time(start), end: time(end) }];
    }));
    // 有早课的日子早起：第一节课
    const firstSlot = Object.entries(periods).sort(([, a], [, b]) => a.start.localeCompare(b.start))[0]?.[0];
    if (!firstSlot) throw new Error('timetable.toml [periods] 是空的');

    const semester = getTable(timetableToml, 'semester', 'timetable.toml');
    const weeks = semester.weeks;
    if (!Number.isInteger(weeks)) throw new Error('timetable.semester.weeks 应为整数');

    const holidays = list(timetableToml, 'holiday').map((h, i) => {
        const at = `timetable.holiday[${i}]`;
        const name = getString(h, 'name', at);
        const extra = config.holidays.get(name);
        return {
            name,
            start: date(getString(h, 'start', at)),
            end: date(getString(h, 'end', at)),
            ...(extra ? { where: extra.where.get(tier)! } : {}),
            ...(extra?.partner && config.partnerTiers.has(tier) ? { partner: extra.partner } : {}),
        };
    });
    for (const name of config.holidays.keys()) {
        if (!holidays.some(h => h.name === name)) throw new Error(`tiers.toml schedule.holiday."${name}"：timetable.toml 里没有这个假期`);
    }

    const makeups = list(timetableToml, 'makeup').map((m, i) => {
        const at = `timetable.makeup[${i}]`;
        const day = date(getString(m, 'date', at));
        const asDay = config.makeup.get(day) ?? m.as_day;
        if (!Number.isInteger(asDay)) throw new Error(`${at}.as_day 应为整数`);
        return { date: day, asDay: asDay as number };
    });
    for (const day of config.makeup.keys()) {
        if (!makeups.some(m => m.date === day)) throw new Error(`tiers.toml schedule.makeup："${day}" 不是 timetable.toml 里的调休日`);
    }

    const detail = config.courseDetail.has(tier);
    const courses = list(timetableToml, 'course').map((c, i) => {
        const at = `timetable.course[${i}]`;
        const slot = getString(c, 'slot', at);
        if (!(slot in periods)) throw new Error(`${at}.slot ${slot} 不在 [periods] 里`);
        const kind = getString(c, 'tier', at) as CourseKind;
        if (!KINDS.includes(kind)) throw new Error(`${at}.tier ${kind} 不是课型`);
        const day = c.day;
        if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 7) throw new Error(`${at}.day 应为 1–7`);
        const practice = c.practice === undefined ? undefined : {
            fromWeek: c.practice as number,
            ...(detail ? { room: getString(c, 'practice_room', at) } : {}),
        };
        return {
            day: day as number,
            slot,
            weeks: getString(c, 'weeks', at),
            kind,
            ...(detail ? { name: getString(c, 'name', at), room: getString(c, 'room', at) } : {}),
            ...(practice ? { practice } : {}),
        };
    });

    const free = { morning: [] as string[], afternoon: [] as string[], evening: [] as string[] };
    for (const [i, f] of list(timetableToml, 'free').entries()) {
        const at = `timetable.free[${i}]`;
        const window = getString(f, 'window', at) as (typeof WINDOWS)[number];
        if (!WINDOWS.includes(window)) throw new Error(`${at}.window ${window} 不是 morning / afternoon / evening`);
        const text = getString(f, 'text', at);
        const only = config.freeOnly.get(text);
        if (!only || only.has(tier)) free[window].push(text);
    }
    const allFree = list(timetableToml, 'free').map(f => getString(f, 'text', 'timetable.free'));
    for (const text of config.freeOnly.keys()) {
        if (!allFree.includes(text)) throw new Error(`tiers.toml schedule.free_only：timetable.toml 里没有「${text}」`);
    }

    const kinds = Object.fromEntries(KINDS.map(kind => {
        const { label, seeAfterMin, maxBubbles } = config.kinds[kind];
        return [kind, { ...(detail ? { label } : {}), ...(seeAfterMin ? { seeAfterMin } : {}), ...(maxBubbles ? { maxBubbles } : {}) }];
    })) as CardSchedule['kinds'];

    return {
        sleep: time(sleep),
        wake: { ...wake, earlySlot: firstSlot },
        periods,
        semester: { start: date(getString(semester, 'start', 'timetable.semester')), weeks: weeks as number },
        holidays,
        makeups,
        kinds,
        courses,
        // 空闲时段的分界（timetable.toml [[free]] 注释：上午到 12:00，下午到 18:00，晚上到睡觉）
        free: { ...free, afternoonFrom: '12:00', eveningFrom: '18:00' },
        where: config.where.get(tier)!,
        ...(config.partner && config.partnerTiers.has(tier) ? { partner: config.partner } : {}),
    };
}

function list(toml: Table, key: string): Table[] {
    const value = toml[key];
    if (!Array.isArray(value) || !value.every(isTable)) throw new Error(`timetable.toml 缺少 [[${key}]]`);
    return value;
}

function time(text: string): string {
    if (!TIME.test(text)) throw new Error(`时间应为 HH:MM：${text}`);
    return text;
}

function date(text: string): string {
    if (!DATE.test(text)) throw new Error(`日期应为 YYYY-MM-DD：${text}`);
    return text;
}

