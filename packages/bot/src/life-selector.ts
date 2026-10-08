// 规则自主选择器 v1（ADR 0040）：没人聊天时她也一件件地过日子。
// 在每个时间边界（上一件事结束、到了饭点、下课……）看她此刻该做什么，变成类型化行动交给裁判（ADR 0037）排进队列（ADR 0038），过完才落进事件账。
// 判断和状态行（contact.ts）用同一套规则：作息和课表（schedule.ts）、饭点和洗澡（ADR 0031）、世界里有时长的事（ADR 0030）、一天的打算（ADR 0034）。
// 过完的日子落进事件账就不再变（相机基金 2300 → 2750 那次：按规则从开学推到现在，改了规则就把过去也改了）。
// 不调模型、不掷随机数：同一份事件账和同一个时刻推出来的一样，重启不重复（行动 id 由开始时刻和种类定）。

import type { ActionContext, ActionIntent, TypedActionKind } from './actions.ts';
import type { ActionQueue } from './action-queue.ts';
import type { BodyNow } from './body.ts';
import { dayPlan, type Plans } from './day-plan.ts';
import type { ReadingBook } from './her-days.ts';
import { readingActivities } from './her-days.ts';
import type { LifeEvent } from './life-events.ts';
import { herDay, stateAt, type ExtraFreeActivity, type Schedule } from './schedule.ts';
import { OCCUPATION_MINUTES, type WorldNow } from './world.ts';

export interface LifeSources {
    schedule: Schedule;
    plans?: Plans;
    books: readonly ReadingBook[];
    /** 那一刻的世界：带上聊天里说过做了的事（WorldState.at）；卡上没有世界时返回 undefined */
    worldAt: (at: Date) => WorldNow | undefined;
    /** 已经落账的事（事件账） */
    events: () => readonly LifeEvent[];
    /** 那一刻她身上怎么样（ADR 0025）：一天的打算按它改（肚子疼躺着、感冒不出门），和 contact.ts 一样 */
    bodyAt?: (at: Date) => BodyNow | undefined;
}

/** 这一刻：要排的行动，或者跳到哪（赶去上课、洗澡、喂猫这类不记成行动的，和短得排不下的空当） */
export type Choice = { intent: ActionIntent; why: string } | { skipTo: Date; why: string };

/** 行动 id：开始时刻 + 种类，同一刻同一件事重放、重启都是同一个 id */
export const lifeActionId = (at: Date, kind: TypedActionKind) => `life:${at.toISOString()}:${kind}`;

/** 世界里不记成行动、但占着时间的事（洗澡、喂猫、取快递往回走、和家里视频）：灵活的行动撞上就停，排的时候跳过 */
export function busySpans(now: WorldNow | undefined): { start: Date; end: Date; text: string }[] {
    if (!now) return [];
    const spans: { start: Date; end: Date; text: string }[] = [];
    const span = (start: Date, minutes: number, text: string) => spans.push({ start, end: new Date(start.getTime() + minutes * 60_000), text });
    if (now.routine?.shower) spans.push({ ...now.routine.shower, text: '洗澡' });
    if (now.cat && 'fed' in now.cat.today) span(now.cat.today.fed, OCCUPATION_MINUTES.feed, `下楼喂${now.cat.name}`);
    for (const parcel of now.parcels.filter(p => p.status === 'picked_today')) span(parcel.when, OCCUPATION_MINUTES.parcel, `取快递（${parcel.item}）`);
    if (now.familyCall?.done) span(now.familyCall.at, OCCUPATION_MINUTES.call, '和家里视频');
    return spans.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * 那一天世界里不记成行动的事：按她这一天快结束时（第二天入睡前一分钟）的世界取——喂猫、取快递在发生之前，那一刻的世界里还只有「打算几点去」，
 * 排一长段追剧时要知道 20:10 得下楼
 */
export function dayBusy(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date): { start: Date; end: Date; text: string }[] {
    return busySpans(sources.worldAt(new Date(windowEnd(sources.schedule, herDayEvening(sources.schedule, at)).getTime() - 60_000)));
}

/** 她这一天晚上那一段里的某一刻（windowEnd 取到的就是第二天入睡） */
function herDayEvening(schedule: Schedule, at: Date): Date {
    const day = herDay(schedule, at);
    const [h, m] = schedule.free.eveningFrom.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** 那一天要赶的作业：写完之前那一段在赶（ADR 0030 的 OCCUPATION_MINUTES.homework） */
function homeworkSprint(now: WorldNow | undefined, at: Date): { start: Date; end: Date; course: string } | undefined {
    const minutes = OCCUPATION_MINUTES.homework * 60_000;
    return now?.homework
        .map(h => ({ start: new Date(h.doneAt.getTime() - minutes), end: h.doneAt, course: h.course }))
        .find(h => at >= h.start && at < h.end);
}

/** 空闲时段做的事归哪一类：在读的书 → 读书；作业 → 学习；躺着 → 休息；别的（追剧、打游戏、修片子……）→ 休闲 */
export function freeKind(text: string, sources: Pick<LifeSources, 'plans' | 'books'>, reading: readonly ExtraFreeActivity[]):
    { kind: TypedActionKind; subject: string } {
    const book = sources.books.find(b => b.activity && reading.some(r => r.text === text) && b.activity.text === text);
    if (book) return { kind: 'read_book', subject: book.id };
    if (sources.plans?.study.includes(text) || /作业|复习|学习|预习/.test(text)) return { kind: 'study', subject: text };
    if (sources.plans?.rest === text || /^(?:躺|休息|睡)/.test(text)) return { kind: 'rest', subject: text };
    return { kind: 'leisure', subject: text };
}

/** 那一天三个时段的边界（和 day-plan.ts 的 windowsOf 一样）：灵活的事最多做到这一段结束 */
function windowEnd(schedule: Schedule, at: Date): Date {
    const day = herDay(schedule, at);
    const time = (hhmm: string, offset = 0) => {
        const [h, m] = hhmm.split(':').map(Number);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, h, m);
    };
    return [time(schedule.free.afternoonFrom), time(schedule.free.eveningFrom), time(schedule.sleep, 1)].find(end => end > at)!;
}

const minutesBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 60_000);
/** 灵活的事最短排多久（短于这个的空当不记，算在路上、发呆） */
const MIN_FREE_MINUTES = 10;

/** 这一刻她该做什么（ADR 0040）：先看作息（睡觉、上课、赶去上课），再看饭点和世界里的事，最后看一天的打算 */
export function chooseAt(at: Date, sources: LifeSources): Choice {
    const reading = readingActivities(sources.books);
    const state = stateAt(sources.schedule, at, reading);
    if (state.activity.kind === 'sleep') return { intent: { id: lifeActionId(at, 'sleep'), kind: 'sleep', startedAt: at }, why: '睡觉' };
    if (state.activity.kind === 'class') {
        const lesson = state.activity.lesson;
        return lesson.start.getTime() === at.getTime()
            ? { intent: { id: lifeActionId(at, 'attend_class'), kind: 'attend_class', startedAt: at }, why: `上${lesson.name ?? '课'}` }
            : { skipTo: lesson.end, why: '课上到一半' };
    }
    if (state.activity.kind === 'between') return { skipTo: state.activity.next.start, why: '赶去上课 / 课间' };

    const world = sources.worldAt(at);
    const meal = world?.routine?.meals.find(m => at >= m.start && at < m.end);
    if (meal) {
        return meal.start.getTime() === at.getTime()
            ? { intent: { id: lifeActionId(at, 'eat'), kind: 'eat', startedAt: at }, why: meal.kind === 'lunch' ? '午饭' : '晚饭' }
            : { skipTo: meal.end, why: '饭吃到一半' };
    }
    const blocks = dayBusy(sources, at);
    const busy = blocks.find(s => at >= s.start && at < s.end);
    if (busy) return { skipTo: busy.end, why: busy.text };

    // 能做到哪：这一段结束、下一顿饭、下一件世界里的事、下一节课，哪个先到（裁判还会再截一次）
    const nextMeal = world?.routine?.meals.find(m => m.start > at)?.start;
    const nextBusy = blocks.find(s => s.start > at)?.start;
    const nextClass = state.nextClass?.start;
    const until = [windowEnd(sources.schedule, at), nextMeal, nextBusy, nextClass].filter((d): d is Date => Boolean(d))
        .reduce((a, b) => (b < a ? b : a));

    const sprint = homeworkSprint(world, at);
    const plan = sprint ? undefined : planned(at, sources, world, reading, state.activity.text);
    const end = sprint && sprint.end < until ? sprint.end : until;
    const minutes = minutesBetween(at, end);
    if (minutes < MIN_FREE_MINUTES) return { skipTo: end > at ? end : new Date(at.getTime() + 60_000), why: '空当太短' };
    const { kind, subject } = sprint ? { kind: 'study' as const, subject: sprint.course ? `${sprint.course}的作业` : '作业' } : plan!;
    return {
        intent: { id: lifeActionId(at, kind), kind, startedAt: at, subject, durationMinutes: clampMinutes(kind, minutes) },
        why: sprint ? '赶作业' : subject,
    };
}

/** 一天的打算这一段实际做的（改了的用改了的；作业压着改的写完就回到原来的打算） */
function planned(at: Date, sources: LifeSources, world: WorldNow | undefined, reading: readonly ExtraFreeActivity[], text: string) {
    const day = herDay(sources.schedule, at);
    const body = sources.bodyAt?.(at);
    const slots = dayPlan(sources.schedule, sources.plans, day, { rain: world?.weather?.rain, ...(body ? { body } : {}), homework: world?.homework }, reading);
    const slot = slots.find(s => s.planned === text);
    const done = slot && slot.done !== slot.planned && !(slot.until && at >= slot.until) ? slot.done : text;
    return done === '先赶作业' ? { kind: 'study' as const, subject: '作业' } : freeKind(done, sources, reading);
}

const LIMITS: Partial<Record<TypedActionKind, [number, number]>> = { study: [25, 120], rest: [15, 120], read_book: [15, 90], leisure: [10, 240] };
/** 请求的时长卡在这一类的上下限里（短于下限的交给裁判判 no_time 之前就跳过了） */
function clampMinutes(kind: TypedActionKind, minutes: number): number {
    const [min, max] = LIMITS[kind] ?? [1, minutes];
    return Math.max(min, Math.min(max, minutes));
}

export interface LifeExecutor {
    /** 从上一件事结束的地方一件件排到 now（开始时刻不晚于 now 的都排；最后一件可能还没做完，在队列里） */
    fill(now: Date): number;
}

/**
 * 执行器：游标是事件账和队列里她自己的行动最晚结束的那一刻（没有就是 since），不另存，重启后照样接上。
 * 裁判不收的（和聊天里说过做了的事撞了、短到排不下）记日志，往后挪一点再看
 */
export function lifeExecutor(sources: LifeSources, queue: ActionQueue, options: { since: Date; log?: (message: string) => void }): LifeExecutor {
    const log = options.log ?? (() => undefined);
    const ends = () => [
        ...sources.events().filter(e => e.id.startsWith('life:')).map(e => Date.parse(e.endedAt)),
        ...queue.pending().filter(item => item.id.startsWith('life:')).map(item => Date.parse(item.event.at)),
    ];
    return {
        fill(now) {
            let cursor = new Date(Math.max(options.since.getTime(), ...ends()));
            let scheduled = 0;
            for (let guard = 0; cursor < now && guard < 2000; guard++) {
                const choice = chooseAt(cursor, sources);
                if ('skipTo' in choice) {
                    cursor = choice.skipTo > cursor ? choice.skipTo : new Date(cursor.getTime() + 60_000);
                    continue;
                }
                const world = sources.worldAt(cursor);
                const context: ActionContext = {
                    schedule: sources.schedule, books: sources.books, events: sources.events(), busy: dayBusy(sources, cursor),
                    ...(world ? { world } : {}),
                };
                const verdict = queue.schedule(choice.intent, context);
                if (verdict.ok) {
                    scheduled++;
                    cursor = new Date(verdict.event.at);
                } else {
                    log(`她的生活：${choice.why}（${choice.intent.kind}）排不上：${verdict.reason}，往后挪 5 分钟`);
                    cursor = new Date(cursor.getTime() + 5 * 60_000);
                }
            }
            return scheduled;
        },
    };
}
