import { localDate } from '../local-date.ts';
import { calendarDate } from '../memory/state-schema.ts';

// 作息（ADR 0007 决策 2）：按角色卡的 extensions.qqbot.schedule（转换器从 legacy 的作息、课表按档位裁剪写入）
// 算出某个时刻她在干什么：睡觉 / 上课 / 课间 / 空闲，在哪，到几点。都按本机时区的本地时间算。
// - 睡觉：sleep（02:00）到起床；这一天第一节有课就 wake.early，否则 wake.lazy。00:00 到 sleep 算前一天的晚上。
// - 上课：这一天有课的节次。放假没有课；调休日按补的那天（0 = 没课）；第几周按学期第 1 周的周一算，转实训以后按机房课算。
// - 空闲：上午（起床到 afternoonFrom）、下午（到 eveningFrom）、晚上（到睡觉）各从活动里按日期固定挑一条；
//   起床或下课之后不到 45 分钟就有下一节的，算赶去上课 / 课间。

export type CourseKind = 'hard' | 'machine' | 'water' | 'pe';

export interface Course {
    /** 持久匿名课程组，跨课表条目/披露档一致；不把课名或其裸哈希当身份。 */
    groupId?: string;
    day: number;
    slot: string;
    weeks: string;
    kind: CourseKind;
    name?: string;
    room?: string;
    practice?: { fromWeek: number; room?: string };
    /** 这门课出小测（everyday.ts）：math 数学类、core 专业课；卡上只有看得到课名的档位才有 */
    quiz?: CourseQuiz;
}

export type CourseQuiz = 'math' | 'core';

export interface Schedule {
    sleep: string;
    /**
     * jitter（ADR 0078）：从 from 那天起，每天起床的时刻在 early / lazy 上下浮动 ±spreadMin 分钟（按日期哈希，同一天每次一样），
     * 有早课的日子最多浮动 10 分钟；没有课的周末再晚 weekendMin 分钟；任何时候不晚于第一节课前 25 分钟。没写 = 每天精确在 early / lazy
     */
    wake: { early: string; lazy: string; earlySlot: string; jitter?: { from: string; spreadMin: number; weekendMin: number } };
    periods: Record<string, { start: string; end: string }>;
    semester: { start: string; weeks: number };
    holidays: { name: string; start: string; end: string; where?: string; partner?: string; partnerBack?: string; home?: boolean }[];
    makeups: { date: string; asDay: number }[];
    kinds: Record<CourseKind, { label?: string; seeAfterMin?: [number, number]; maxBubbles?: number }>;
    courses: Course[];
    free: {
        morning: string[]; afternoon: string[]; evening: string[]; afternoonFrom: string; eveningFrom: string;
        /** 从 from 那天起才进抽签列表（ADR 0053 之后：买了相机才有的活动）；那天以前抽到的不变 */
        later?: { window: 'morning' | 'afternoon' | 'evening'; text: string; from: string; until?: string }[];
        /** 在家的假期（holidays[].home）里用的这一份，没有就沿用上面的 */
        home?: { morning: string[]; afternoon: string[]; evening: string[] };
        /** 某一天某个时段专门做的事（公共节日，ADR 0076）：那一天那个时段只从这里挑；home 写了就只在在家 / 在学校的那天用 */
        on?: { date: string; window: 'morning' | 'afternoon' | 'evening'; text: string; home?: boolean }[];
    };
    where: string;
    partner?: string;
}

/** 某一天的一节课：课型已按转实训换算，start / end 是当天的时刻 */
export interface ClassToday {
    /** 课表数组里的稳定位置；各档即使看不到课名也一致。 */
    id?: string;
    /** 内部匿名分组；和 id 一样不进入枚举快照与提示词。 */
    groupId?: string;
    /** 这门课出小测（Course.quiz）；和 id 一样不可枚举 */
    quiz?: CourseQuiz;
    kind: CourseKind;
    name?: string;
    room?: string;
    start: Date;
    end: Date;
}

export type Activity =
    | { kind: 'sleep'; until: Date }
    | { kind: 'class'; lesson: ClassToday }
    /** 起床后赶去上课（afterClass false）、课间（true） */
    | { kind: 'between'; next: ClassToday; afterClass: boolean }
    | { kind: 'free'; text: string };

export interface State {
    activity: Activity;
    /** 这一天在放的假 */
    holiday?: Schedule['holidays'][number];
    /** 她在哪：放假时用假期的说法（没有就只说放假），否则用平时的 */
    where: string;
    /** 他在哪（只有知道他的档位有） */
    partner?: string;
    /** partner 是放完假几天里的说法（partnerBack）：状态行里单独一行，不跟在「你现在」最后（ADR 0007 调整 2026-10-10） */
    partnerJustBack?: boolean;
    /** 今天接下来的下一节课（正在上的不算） */
    nextClass?: ClassToday;
    /** 学期外（第 1 周之前、最后一周之后）：没有课 */
    outsideSemester: boolean;
}

const DAY_MS = 86_400_000;
/** 放完假这么多天之内，他在哪用假期的 partnerBack（「放完假回学校了」）：聊天记录里还留着假期里他说的「我在青岛」 */
export const PARTNER_BACK_DAYS = 7;
/** 起床或下课到下一节课不超过这么久，算赶去上课 / 课间，不挑空闲活动 */
const BETWEEN_MAX_MS = 45 * 60_000;

/** herDays 等可按开关临时并入的空闲活动，不改旧 schedule.yml。 */
export interface ExtraFreeActivity { window: 'morning' | 'afternoon' | 'evening'; text: string }

export function stateAt(schedule: Schedule, now: Date, extraFree: readonly ExtraFreeActivity[] = []): State {
    const day = herDay(schedule, now);
    const sleepStart = at(startOfDay(now), schedule.sleep);
    const holiday = holidayOn(schedule, day);
    const where = holiday ? [`${holiday.name}放假`, holiday.where].filter(Boolean).join('，') : schedule.where;
    const justBack = holiday ? undefined : schedule.holidays.find(h => h.partnerBack && h.end < formatDate(day)
        && day.getTime() - parseDate(h.end).getTime() <= PARTNER_BACK_DAYS * DAY_MS);
    const partner = holiday ? holiday.partner : justBack?.partnerBack ?? schedule.partner;
    const { lessons, outsideSemester } = classesOn(schedule, day);
    const base = { holiday, where, ...(partner ? { partner } : {}), ...(justBack ? { partnerJustBack: true } : {}), outsideSemester };

    if (now < sleepStart) return { ...base, activity: { kind: 'free', text: freeActivity(schedule, day, 'evening', extraFree) } };
    const wake = wakeTime(schedule, day, lessons);
    if (now < wake) return { ...base, activity: { kind: 'sleep', until: wake } };

    const nextClass = lessons.find(l => l.start > now);
    const withNext = { ...base, ...(nextClass ? { nextClass } : {}) };
    const current = lessons.find(l => l.start <= now && now < l.end);
    if (current) return { ...withNext, activity: { kind: 'class', lesson: current } };
    // 起床或下课之后不到 45 分钟就有下一节：赶去上课、课间
    const previous = lessons.findLast(l => l.end <= now);
    if (nextClass && nextClass.start.getTime() - (previous?.end ?? wake).getTime() <= BETWEEN_MAX_MS) {
        return { ...withNext, activity: { kind: 'between', next: nextClass, afterClass: previous !== undefined } };
    }
    const window = now < at(day, schedule.free.afternoonFrom) ? 'morning' : now < at(day, schedule.free.eveningFrom) ? 'afternoon' : 'evening';
    return { ...withNext, activity: { kind: 'free', text: freeActivity(schedule, day, window, extraFree) } };
}

/** 这一刻属于她的哪一天：睡觉时刻（02:00）之前算前一天。心情、读书进度、主动消息都用这一条。 */
export function herDay(schedule: Schedule, now: Date): Date {
    const date = startOfDay(now);
    return now < at(date, schedule.sleep) ? localDate(date.getFullYear(), date.getMonth(), date.getDate() - 1) : date;
}

/** 某一天要上的课，按开始时间排好 */
export function classesOn(schedule: Schedule, day: Date): { lessons: ClassToday[]; outsideSemester: boolean } {
    const week = Math.floor((startOfDay(day).getTime() - parseDate(schedule.semester.start).getTime()) / (7 * DAY_MS)) + 1;
    const outsideSemester = week < 1 || week > schedule.semester.weeks;
    if (outsideSemester || holidayOn(schedule, day)) return { lessons: [], outsideSemester };
    const makeup = schedule.makeups.find(m => m.date === formatDate(day));
    const weekday = makeup ? makeup.asDay : (day.getDay() || 7);
    const lessons = schedule.courses
        .map((course, index) => ({ course, index }))
        .filter(({ course }) => course.day === weekday && inWeeks(course.weeks, week))
        .map(({ course: c, index }): ClassToday => {
            const practice = c.practice && week >= c.practice.fromWeek;
            const period = schedule.periods[c.slot]!;
            const lesson: ClassToday = {
                kind: practice ? 'machine' : c.kind,
                ...(c.name ? { name: c.name } : {}),
                ...((practice ? c.practice!.room : c.room) ? { room: (practice ? c.practice!.room : c.room)! } : {}),
                start: at(day, period.start),
                end: at(day, period.end),
            };
            // 内部稳定标识不进日志、提示词或测试快照；各档课表数组顺序相同。
            Object.defineProperty(lesson, 'id', { value: `course-${index + 1}`, enumerable: false });
            if (c.groupId) Object.defineProperty(lesson, 'groupId', { value: c.groupId, enumerable: false });
            if (c.quiz) Object.defineProperty(lesson, 'quiz', { value: c.quiz, enumerable: false });
            return lesson;
        })
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    return { lessons, outsideSemester };
}

/** 某一天几点起（主动消息的早安按它算，ADR 0011） */
export function wakeOn(schedule: Schedule, day: Date): Date {
    return wakeTime(schedule, startOfDay(day), classesOn(schedule, day).lessons);
}

/** 这一天几点起：第一节有课就早起 */
/** 那天几点起：第一节是早八就早起，否则睡到自然醒（ADR 0025 的困也用它） */
export function wakeTime(schedule: Schedule, day: Date, lessons: ClassToday[]): Date {
    const early = schedule.periods[schedule.wake.earlySlot];
    const hasEarly = early !== undefined && lessons.some(l => l.start.getTime() === at(day, early.start).getTime());
    const base = at(day, hasEarly ? schedule.wake.early : schedule.wake.lazy);
    const jitter = schedule.wake.jitter;
    if (!jitter || formatDate(day) < jitter.from) return base;
    // 浮动（ADR 0078）：有早课的日子只浮动一点，赶得上第一节；周末没课再晚一点；不晚于第一节课前 25 分钟（原来 09:30 起、09:55 上课的日子不动）
    const spread = hasEarly ? Math.min(jitter.spreadMin, 10) : jitter.spreadMin;
    const fraction = (hash(`${formatDate(day)} wake`) % 10_000) / 10_000;
    let minutes = Math.round((fraction * 2 - 1) * spread);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    if (weekend && !hasEarly && lessons.length === 0) minutes += jitter.weekendMin;
    let wake = base.getTime() + minutes * 60_000;
    const first = lessons[0];
    if (first) wake = Math.min(wake, first.start.getTime() - 25 * 60_000);
    return new Date(wake);
}

function holidayOn(schedule: Schedule, day: Date): Schedule['holidays'][number] | undefined {
    const d = formatDate(day);
    return schedule.holidays.find(h => h.start <= d && d <= h.end);
}

/** 这一天她在家过（假期标了 home） */
export function atHome(schedule: Schedule, day: Date): boolean {
    return holidayOn(schedule, day)?.home === true;
}

/** 同一天同一时段固定挑同一条（按日期 + 时段哈希） */
function freeActivity(schedule: Schedule, day: Date, window: 'morning' | 'afternoon' | 'evening', extra: readonly ExtraFreeActivity[]): string {
    const date = formatDate(day);
    // 节日这一天这个时段有专门的事：只从它们里挑
    const special = (schedule.free.on ?? []).filter(item => item.date === date && item.window === window && (item.home === undefined || item.home === atHome(schedule, day)));
    if (special.length) return special[hash(`${date} ${window} on`) % special.length]!.text;
    // 在家的假期：用在家的那一份（卡里有才用，没有就还是学校的）
    const home = atHome(schedule, day) ? schedule.free.home?.[window] : undefined;
    if (home?.length) return home[hash(`${date} ${window}`) % home.length]!;
    const later = (schedule.free.later ?? []).filter(item => item.window === window && item.from <= date && (!item.until || date <= item.until)).map(item => item.text);
    const list = [...schedule.free[window], ...later, ...extra.filter(item => item.window === window).map(item => item.text)];
    if (list.length === 0) return '';
    return list[hash(`${formatDate(day)} ${window}`) % list.length]!;
}

/** "1-16"、"1-2,4-16,18" */
export function inWeeks(spec: string, week: number): boolean {
    return spec.split(',').some(part => {
        const [from, to = from] = part.split('-').map(s => Number(s.trim()));
        return from !== undefined && week >= from && week <= to!;
    });
}

/** FNV-1a */
function hash(text: string): number {
    let h = 0x811c9dc5;
    for (const ch of text) {
        h ^= ch.codePointAt(0)!;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
}

function startOfDay(date: Date): Date {
    return localDate(date.getFullYear(), date.getMonth(), date.getDate());
}

/** 某天的 HH:MM */
function at(day: Date, time: string): Date {
    const [h, m] = time.split(':').map(Number);
    return localDate(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

function parseDate(text: string): Date {
    const [y, m, d] = text.split('-').map(Number);
    return localDate(y!, m! - 1, d);
}

export function formatDate(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const year = date.getFullYear();
    const text = year >= 0 && year <= 9999 ? String(year).padStart(4, '0') : String(year);
    return `${text}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------- 状态行（ADR 0007 决策 3） ----------

/**
 * 时间块里的一行：她在哪、在干什么、他在哪。卡上没写的（低档位的课名、教室）就不说。
 * woken：睡着时被消息吵醒（男朋友档，决策 6）；userName：他在哪的说法里的 {{user}} 换成称呼
 */
/**
 * 放完假那几天「他已经回学校了」那一行（partnerBack）；不是那几天就是 undefined。
 * 提示词里放在时间块事实的最后、离他最新的话最近（describeState 传 partnerApart）：放在第 4 行时，合进 ADR 0051 / 0052 的两段说明后
 * 「你不是在青岛吗」又回来了（schedule-boyfriend 10 次里 3 次；挪到最后 22 次里 1 次，2026-10-10）
 */
export function partnerBackLine(state: State, userName?: string): string | undefined {
    return state.partnerJustBack && state.partner ? `[${state.partner.replaceAll('{{user}}', userName ?? '他')}]` : undefined;
}

export function describeState(state: State, schedule: Schedule, options: { woken?: boolean; userName?: string; partnerApart?: boolean } = {}): string {
    const { activity } = state;
    const course = (lesson: ClassToday) => lesson.name ?? '课';
    let doing: string;
    switch (activity.kind) {
        case 'sleep':
            doing = options.woken ? `${state.holiday?.home ? '在家' : '在宿舍'}睡觉，被消息震醒了，迷迷糊糊的` : `${state.holiday?.home ? '在家' : '在宿舍'}睡觉，${clock(activity.until)} 起`;
            break;
        case 'class': {
            const { lesson } = activity;
            const label = schedule.kinds[lesson.kind].label;
            doing = `${lesson.room ? `在${lesson.room}` : '在'}上${course(lesson)}${label ? `（${label}）` : ''}，${clock(lesson.end)} 下课`;
            if (lesson.kind === 'hard' || lesson.kind === 'machine') doing += '，偷偷看手机回消息，回得简短';
            break;
        }
        case 'between':
            doing = `${activity.afterClass ? '课间' : '刚起床'}，${clock(activity.next.start)} ${activity.afterClass ? '接着上' : '要上'}${course(activity.next)}`;
            break;
        case 'free':
            doing = activity.text || '没课';
            if (state.nextClass) doing += `，今天 ${clock(state.nextClass.start)} 还有${course(state.nextClass)}`;
            break;
    }
    const partner = state.partner?.replaceAll('{{user}}', options.userName ?? '他');
    // 放完假那几天他在哪单独一行：跟在「你现在」最后时，她仍信聊天记录里假期中他说的「我在青岛」（ADR 0007 调整 2026-10-10）
    // partnerApart：那一行由调用方用 partnerBackLine 放到别处（提示词里放在时间块事实的最后）
    if (state.partnerJustBack && partner) return `[你现在：${[state.where, doing].filter(Boolean).join('；')}]${options.partnerApart ? '' : `\n[${partner}]`}`;
    return `[你现在：${[state.where, doing, partner].filter(Boolean).join('；')}]`;
}

function clock(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ---------- 读卡 ----------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: CourseKind[] = ['hard', 'machine', 'water', 'pe'];

/** 校验角色卡 extensions.qqbot.schedule 的结构（转换器写的，手改坏了要早报错） */
export function parseSchedule(json: unknown, source: string): Schedule {
    const fail = (what: string): never => { throw new Error(`${source}：extensions.qqbot.schedule${what}`); };
    const obj = (v: unknown, at: string): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : fail(`${at} 应为对象`));
    const str = (v: unknown, at: string, re?: RegExp): string => {
        if (re === DATE) return typeof v === 'string' && calendarDate(v) ? v : fail(`${at} 不是有效日期`);
        return typeof v === 'string' && (!re || re.test(v)) ? v : fail(`${at} 格式不对：${String(v)}`);
    };
    const arr = (v: unknown, at: string): unknown[] => (Array.isArray(v) ? v : fail(`${at} 应为数组`));
    const int = (v: unknown, at: string): number => (Number.isInteger(v) ? v as number : fail(`${at} 应为整数`));
    const opt = <T>(v: unknown, read: (v: unknown) => T): T | undefined => (v === undefined ? undefined : read(v));

    const s = obj(json, '');
    const wake = obj(s.wake, '.wake');
    const periods = Object.fromEntries(Object.entries(obj(s.periods, '.periods')).map(([slot, p]) => {
        const period = obj(p, `.periods.${slot}`);
        return [slot, { start: str(period.start, `.periods.${slot}.start`, TIME), end: str(period.end, `.periods.${slot}.end`, TIME) }];
    }));
    const semester = obj(s.semester, '.semester');
    const kindsObj = obj(s.kinds, '.kinds');
    const kinds = Object.fromEntries(KINDS.map(kind => {
        const k = obj(kindsObj[kind], `.kinds.${kind}`);
        const see = opt(k.seeAfterMin, v => {
            const a = arr(v, `.kinds.${kind}.seeAfterMin`);
            return (a.length === 2 && a.every(n => typeof n === 'number' && n >= 0) ? a : fail(`.kinds.${kind}.seeAfterMin 应为 [最少, 最多]`)) as [number, number];
        });
        return [kind, {
            ...(k.label !== undefined ? { label: str(k.label, `.kinds.${kind}.label`) } : {}),
            ...(see ? { seeAfterMin: see } : {}),
            ...(k.maxBubbles !== undefined ? { maxBubbles: int(k.maxBubbles, `.kinds.${kind}.maxBubbles`) } : {}),
        }];
    })) as Schedule['kinds'];
    const free = obj(s.free, '.free');
    const texts = (v: unknown, at: string) => arr(v, at).map((t, i) => str(t, `${at}[${i}]`));
    const schedule: Schedule = {
        sleep: str(s.sleep, '.sleep', TIME),
        wake: {
            early: str(wake.early, '.wake.early', TIME), lazy: str(wake.lazy, '.wake.lazy', TIME), earlySlot: str(wake.earlySlot, '.wake.earlySlot'),
            ...(wake.jitter !== undefined ? (() => {
                const j = obj(wake.jitter, '.wake.jitter');
                return { jitter: { from: str(j.from, '.wake.jitter.from', DATE), spreadMin: int(j.spreadMin, '.wake.jitter.spreadMin'), weekendMin: int(j.weekendMin, '.wake.jitter.weekendMin') } };
            })() : {}),
        },
        periods,
        semester: { start: str(semester.start, '.semester.start', DATE), weeks: int(semester.weeks, '.semester.weeks') },
        holidays: arr(s.holidays, '.holidays').map((h, i) => {
            const o = obj(h, `.holidays[${i}]`);
            return {
                name: str(o.name, `.holidays[${i}].name`),
                start: str(o.start, `.holidays[${i}].start`, DATE),
                end: str(o.end, `.holidays[${i}].end`, DATE),
                ...(o.where !== undefined ? { where: str(o.where, `.holidays[${i}].where`) } : {}),
                ...(o.partner !== undefined ? { partner: str(o.partner, `.holidays[${i}].partner`) } : {}),
                ...(o.partnerBack !== undefined ? { partnerBack: str(o.partnerBack, `.holidays[${i}].partnerBack`) } : {}),
                ...(o.home === true ? { home: true } : {}),
            };
        }),
        makeups: arr(s.makeups, '.makeups').map((m, i) => {
            const o = obj(m, `.makeups[${i}]`);
            return { date: str(o.date, `.makeups[${i}].date`, DATE), asDay: int(o.asDay, `.makeups[${i}].asDay`) };
        }),
        kinds,
        courses: arr(s.courses, '.courses').map((c, i): Course => {
            const o = obj(c, `.courses[${i}]`);
            const at = `.courses[${i}]`;
            if (o.groupId !== undefined && (typeof o.groupId !== 'string' || !/^cg-[0-9a-f]{32}$/.test(o.groupId))) fail(`${at}.groupId 应为匿名课程令牌`);
            const slot = str(o.slot, `${at}.slot`);
            if (!(slot in periods)) fail(`${at}.slot ${slot} 不在 periods 里`);
            const kind = str(o.kind, `${at}.kind`) as CourseKind;
            if (!KINDS.includes(kind)) fail(`${at}.kind ${kind} 不是课型`);
            if (o.quiz !== undefined && o.quiz !== 'math' && o.quiz !== 'core') fail(`${at}.quiz 应为 math / core`);
            const practice = opt(o.practice, v => {
                const p = obj(v, `${at}.practice`);
                return { fromWeek: int(p.fromWeek, `${at}.practice.fromWeek`), ...(p.room !== undefined ? { room: str(p.room, `${at}.practice.room`) } : {}) };
            });
            return {
                day: int(o.day, `${at}.day`),
                slot,
                weeks: str(o.weeks, `${at}.weeks`, /^\d+(-\d+)?(,\d+(-\d+)?)*$/),
                kind,
                ...(o.groupId !== undefined ? { groupId: o.groupId as string } : {}),
                ...(o.name !== undefined ? { name: str(o.name, `${at}.name`) } : {}),
                ...(o.room !== undefined ? { room: str(o.room, `${at}.room`) } : {}),
                ...(practice ? { practice } : {}),
                ...(o.quiz !== undefined ? { quiz: o.quiz as CourseQuiz } : {}),
            };
        }),
        free: {
            morning: texts(free.morning, '.free.morning'),
            afternoon: texts(free.afternoon, '.free.afternoon'),
            evening: texts(free.evening, '.free.evening'),
            afternoonFrom: str(free.afternoonFrom, '.free.afternoonFrom', TIME),
            eveningFrom: str(free.eveningFrom, '.free.eveningFrom', TIME),
            ...(free.on !== undefined ? {
                on: arr(free.on, '.free.on').map((v, i) => {
                    const path = `.free.on[${i}]`;
                    const o = obj(v, path);
                    const date = str(o.date, `${path}.date`, DATE);
                    const window = str(o.window, `${path}.window`) as 'morning' | 'afternoon' | 'evening';
                    if (!['morning', 'afternoon', 'evening'].includes(window)) fail(`${path}.window 无效`);
                    const text = str(o.text, `${path}.text`).trim();
                    if (!text) fail(`${path}.text 不能为空`);
                    if (o.home !== undefined && typeof o.home !== 'boolean') fail(`${path}.home 应为布尔值`);
                    return { date, window, text, ...(o.home === undefined ? {} : { home: o.home as boolean }) };
                }),
            } : {}),
            ...(free.home !== undefined ? (() => {
                const home = obj(free.home, '.free.home');
                return { home: { morning: texts(home.morning, '.free.home.morning'), afternoon: texts(home.afternoon, '.free.home.afternoon'), evening: texts(home.evening, '.free.home.evening') } };
            })() : {}),
            ...(free.later !== undefined ? {
                later: arr(free.later, '.free.later').map((v, i) => {
                    const o = obj(v, `.free.later[${i}]`);
                    const window = str(o.window, `.free.later[${i}].window`) as 'morning' | 'afternoon' | 'evening';
                    if (!['morning', 'afternoon', 'evening'].includes(window)) fail(`.free.later[${i}].window ${window}`);
                    return {
                        window, text: str(o.text, `.free.later[${i}].text`), from: str(o.from, `.free.later[${i}].from`, DATE),
                        ...(o.until !== undefined ? { until: str(o.until, `.free.later[${i}].until`, DATE) } : {}),
                    };
                }),
            } : {}),
        },
        where: str(s.where, '.where'),
        ...(s.partner !== undefined ? { partner: str(s.partner, '.partner') } : {}),
    };
    if (!(schedule.wake.earlySlot in periods)) fail(`.wake.earlySlot ${schedule.wake.earlySlot} 不在 periods 里`);
    return schedule;
}
