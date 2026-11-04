// 她哪段时间不方便、为什么（ADR 0066）：推掉、改约的理由只能是这四类确定性的事实——有课（含调休补课）、赶作业（24 小时内到期的）、
// 当天身体不舒服、那个点已经约了别的事。纯函数，同样的输入同样的输出（重启一致）；没有障碍就没有拒绝和改约，没有任何随机项。
// - obstaclesBetween：某段时间里的障碍，每个带类、一句事实、事实 id（日志里能指到来源）。
// - newObstacles：约好之后才出现的（约的时候她不可能知道的）：当天的身体、约好之后才布置的作业；课和别的约约的时候就看得到。
// - describeObstacles：他提到见面时放进时间块的一行（只给事实，是否推、怎么说由她定）。

import type { BodyNow } from '../life/body.ts';
import { createHash } from 'node:crypto';
import { localDate } from '../local-date.ts';
import { unwell } from '../life/body.ts';
import { MEET_LEAD_MINUTES, type Appointment } from '../life/promises.ts';
import { classesOn, formatDate, herDay, type Schedule } from '../life/schedule.ts';
import { OCCUPATION_MINUTES, type WorldNow } from './world.ts';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const OBSTACLE_KINDS = ['unwell', 'homework', 'class', 'other_meet'] as const;
export type ObstacleKind = (typeof OBSTACLE_KINDS)[number];

export interface Obstacle {
    kind: ObstacleKind;
    /** 事实 id：class / homework / unwell / meet 前缀；作业含到期与完成时刻及来源指纹，不包含原始课程名。 */
    id: string;
    /** 一句事实，不带时间（「有课（机房课）」）；日志和说明里用 */
    text: string;
    start: Date;
    end: Date;
    /** homework：作业哪天布置的（她的一天）；判断是不是约好之后才有的 */
    assigned?: string;
}

export interface ObstacleFacts {
    schedule: Schedule;
    /** 她那一刻的世界（作业）；没有就没有「赶作业」这一类 */
    worldAt?: (at: Date) => WorldNow | undefined;
    /** 某一刻她身上的事实；没有就没有「身体不舒服」这一类（卡上没写身体的档位） */
    bodyAt?: (at: Date) => BodyNow;
    /** 一段时间里已经约好的见面（promiseKeeper.appointmentsBetween）；没有就没有「已经约了别的」这一类 */
    appointments?: (from: Date, to: Date) => readonly Appointment[];
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();

/** 她的一天从睡觉时刻（schedule.sleep，02:00）起算到第二天的这个时刻：herDay 的另一头，身体那一类的窗口用它（原来写成 [D 00:00, D+1 02:00)，凌晨两小时会算到前一天的身上） */
function herDayWindow(schedule: Schedule, day: Date): { start: Date; end: Date } {
    const [h, m] = schedule.sleep.split(':').map(Number);
    return { start: localDate(day.getFullYear(), day.getMonth(), day.getDate(), h, m), end: localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1, h, m) };
}

function lessonName(facts: ObstacleFacts, lesson: ReturnType<typeof classesOn>['lessons'][number]): string {
    return lesson.name ?? facts.schedule.kinds[lesson.kind]?.label?.split('，')[0] ?? '课';
}

/** 身上不舒服的说法：生理期细节只给说得出口的档位（BodyNow.period.detail） */
function unwellText(body: BodyNow): string {
    const detail: string[] = [];
    if (body.period?.cramps && body.period.detail) detail.push('生理期，肚子疼');
    if (body.cold) detail.push('感冒');
    return detail.length ? `身上不舒服（${detail.join('、')}）` : '身上不舒服';
}

/**
 * [from, to) 里她不方便的原因，按开始的时刻排。exclude：不算这件约（改约时看的是别的约）。
 * 作业只认 24 小时内到期、还没写完的：她赶作业的那段（写完前 OCCUPATION_MINUTES.homework 分钟，和世界里「在赶作业」是同一段）和这段时间重叠才算
 */
export function obstaclesBetween(from: Date, to: Date, facts: ObstacleFacts, exclude?: string): Obstacle[] {
    const found = new Map<string, Obstacle>();
    const put = (obstacle: Obstacle) => { if (!found.has(obstacle.id)) found.set(obstacle.id, obstacle); };
    for (let day = herDay(facts.schedule, from); day.getTime() < to.getTime(); day = localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        const date = formatDate(day);
        for (const lesson of classesOn(facts.schedule, day).lessons) {
            if (!overlaps(lesson.start, lesson.end, from, to)) continue;
            put({
                kind: 'class', id: `class:${date}:${lesson.id ?? clock(lesson.start)}`, start: lesson.start, end: lesson.end,
                text: `有课（${lessonName(facts, lesson)}，${clock(lesson.start)}–${clock(lesson.end)}）`,
            });
        }
        const dayStart = localDate(day.getFullYear(), day.getMonth(), day.getDate());
        const own = herDayWindow(facts.schedule, day);
        if (facts.bodyAt && overlaps(own.start, own.end, from, to)) {
            const body = facts.bodyAt(localDate(day.getFullYear(), day.getMonth(), day.getDate(), 15));
            if (unwell(body)) put({ kind: 'unwell', id: `unwell:${date}`, start: own.start, end: own.end, text: unwellText(body) });
        }
        const world = facts.worldAt?.(from.getTime() > dayStart.getTime() ? from : dayStart);
        for (const h of world?.homework ?? []) {
            if (h.done || h.due.getTime() - h.doneAt.getTime() > DAY_MS) continue;
            const start = new Date(h.doneAt.getTime() - OCCUPATION_MINUTES.homework * 60_000);
            if (!overlaps(start, h.doneAt, from, to)) continue;
            const identity = createHash('sha256').update(JSON.stringify([h.course ?? '', h.assigned ?? ''])).digest('hex').slice(0, 16);
            put({
                kind: 'homework', id: `homework:${h.due.getTime()}:${h.doneAt.getTime()}:${identity}`, start, end: h.doneAt, ...(h.assigned ? { assigned: h.assigned } : {}),
                text: `要赶作业${h.course ? `（${h.course}）` : ''}，${clock(h.doneAt)} 左右写完`,
            });
        }
    }
    for (const meeting of facts.appointments?.(from, to) ?? []) {
        if (meeting.promise.id === exclude) continue;
        const start = new Date(meeting.start.getTime() - MEET_LEAD_MINUTES * 60_000);
        if (!overlaps(start, meeting.end, from, to)) continue;
        put({ kind: 'other_meet', id: `meet:${meeting.promise.id}`, start, end: meeting.end, text: `已经约了别的事（${clock(meeting.start)}）` });
    }
    return [...found.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * 约好之后才出现的障碍（ADR 0066 决策 3）：约的那天她不可能知道的——约好之后才有的身体不舒服（当天的身体不看未来，感冒不可预知），
 * 约好之后才布置的作业。课（含调休补课）和别的约约的时候就看得到，不算「新」的，别的约也不算（两件约撞了是约的时候的事，不是后来出了事）
 */
export function newObstacles(found: readonly Obstacle[], promise: { said: string }): Obstacle[] {
    return found.filter(o => (o.kind === 'unwell'
        ? formatDate(o.start) > promise.said
        : o.kind === 'homework' ? (o.assigned ?? '') > promise.said : false));
}

/**
 * 这一天（她的一天，YYYY-MM-DD）她已经知道的障碍：当天的身体不看未来（今天看不到明天的痛经），还没布置的作业她不知道（不知道哪天布置的当作知道）；
 * 课（含调休补课）和别的约一直看得到
 */
export function knownBy(o: Obstacle, today: string): boolean {
    return o.kind === 'unwell' ? formatDate(o.start) <= today : o.kind === 'homework' ? (o.assigned ?? '') <= today : true;
}

const WEEKDAYS = '日一二三四五六';
/** 时间块里最多写几条障碍；超过的说明后面还有（DSH 复核 0066 问题 7：切掉的明后天被表头的「没写到的都有空」说成有空） */
const LINES_MAX = 6;

/**
 * 他提到见面时，往后看哪几天：话里有「明天」「后天」「大后天」「周X」「下周X」「周末」「今晚」就只看那天（周末看周六周日），没有就看今天到后天。
 * today 是她的一天；now 给了，并且已经过了零点、还没到她睡觉的时刻（herDay 还是前一个日历日）时，他嘴里的「今天 / 今晚 / 下午 / 晚上」是日历上的今天，也就是她的一天的下一天——
 * 凌晨一点他说「今天晚上一起吃饭」，原来算成已经过去的那一天，整桶丢掉（DSH 10-15 复核 0066 问题 1）
 */
export function meetupDays(text: string, today: Date, now?: Date): Date[] {
    const plus = (n: number) => localDate(today.getFullYear(), today.getMonth(), today.getDate() + n);
    const late = now !== undefined && formatDate(now) !== formatDate(today) ? 1 : 0;
    const dayIndex = (word: string) => WEEKDAYS.indexOf(word === '天' ? '日' : word);
    // 周一为一周的开头：下周X = 下一个周一再往后数
    const nextMonday = 7 - ((today.getDay() + 6) % 7);
    const nextWeek = text.match(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/);
    if (nextWeek) return [plus(nextMonday + ((dayIndex(nextWeek[1]!) + 6) % 7))];
    if (/下(?:个)?(?:周|星期|礼拜)末/.test(text)) return [plus(nextMonday + 5), plus(nextMonday + 6)];
    if (/周末/.test(text)) {
        // 周六周日：今天已经是周末就从今天起
        const sat = (6 - today.getDay() + 7) % 7;
        return today.getDay() === 0 ? [plus(0)] : [plus(sat), plus(sat + 1)];
    }
    const week = text.match(/(?:周|星期|礼拜)([一二三四五六日天])/);
    if (week) return [plus((dayIndex(week[1]!) - today.getDay() + 7) % 7)];
    if (/大后天/.test(text)) return [plus(3)];
    if (/后天/.test(text)) return [plus(2)];
    if (/明天|明晚|明早|明午/.test(text)) return [plus(1)];
    if (/今晚|今天|今早|中午|下午|晚上/.test(text)) return [plus(late)];
    return [plus(0), plus(1), plus(2)];
}

/**
 * 时间块里的一行（ADR 0066 决策 2）：他提到见面时，她那几天不方便的时段。只给事实，不强制；没有障碍就什么都不加
 * （沿用 ADR 0046「想去就答应」）。viewer 的称呼不进这一行，别的约不说是谁
 */
export function describeObstacles(days: readonly Date[], now: Date, facts: ObstacleFacts): string | undefined {
    const today = herDay(facts.schedule, now);
    // 「今天 / 明天」按日历日叫（凌晨一点他说的今天是日历上的今天）；身体那类只认她的那一天，不把前一个她的一天的身体说成「明天整天」
    const calendarToday = localDate(now.getFullYear(), now.getMonth(), now.getDate());
    const lines: string[] = [];
    for (const day of days) {
        const dayStart = localDate(day.getFullYear(), day.getMonth(), day.getDate());
        const from = new Date(Math.max(now.getTime(), dayStart.getTime()));
        const to = new Date(dayStart.getTime() + DAY_MS);
        if (from.getTime() >= to.getTime()) continue;
        const offset = Math.round((dayStart.getTime() - calendarToday.getTime()) / DAY_MS);
        const word = offset === 0 ? '今天' : offset === 1 ? '明天' : offset === 2 ? '后天' : `周${WEEKDAYS[dayStart.getDay()]}`;
        for (const o of obstaclesBetween(from, to, facts).filter(o => knownBy(o, formatDate(today)) && (o.kind !== 'unwell' || o.id === `unwell:${formatDate(dayStart)}`))) {
            lines.push(o.kind === 'unwell' ? `${word}整天 ${o.text}` : o.kind === 'other_meet' ? `${word} ${o.text}` : `${word} ${clock(o.start)}–${clock(o.end)} ${o.text}`);
        }
    }
    return lines.length
        ? `[你${days.length > 1 ? '这几天' : '那天'}不方便的时段（事实；他约见面时对照：约在这些时段里你多半得推掉或者改时间，说原因就照这里写的，别编别的；${lines.length > LINES_MAX ? `这里只写了最早的 ${LINES_MAX} 条，后面的还有没写出来的，别当成有空` : '没写到的时段你都有空'}）：${lines.slice(0, LINES_MAX).join('；')}]`
        : undefined;
}
