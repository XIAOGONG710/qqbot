// 类型化行动与世界裁判（ADR 0037）。
// 模型和未来的自主选择器只提交“想做什么”；本模块按真实课表、日常、读书状态和事件账决定能否发生。
// 首刀只把时间当硬资源，不另造一套精力、钱或章节进度，避免和 body.ts、money.ts、her-days.ts 形成双事实源。

import { bookProgressAt, type ReadingBook } from './her-days.ts';
import type { LifeEvent, LifeEventDraft, LifeEventSource } from './life-events.ts';
import { classesOn, formatDate, herDay, stateAt, type Schedule } from './schedule.ts';
import type { WorldNow } from './world.ts';

export type TypedActionKind = 'sleep' | 'eat' | 'attend_class' | 'study' | 'rest' | 'read_book';
export type ActionFailure = 'invalid_time' | 'unavailable' | 'conflict' | 'no_time' | 'missing_target' | 'already_done';

export interface ActionIntent {
    id: string;
    kind: TypedActionKind;
    startedAt: Date;
    source?: LifeEventSource;
    subject?: string;
    durationMinutes?: number;
}

export interface ActionContext {
    schedule: Schedule;
    world?: WorldNow;
    books?: readonly ReadingBook[];
    events?: readonly LifeEvent[];
}

export type ActionVerdict = {
    ok: true;
    event: LifeEventDraft;
    occupation: string;
    requestedMinutes: number;
    actualMinutes: number;
} | {
    ok: false;
    event: LifeEventDraft;
    reason: ActionFailure;
};

interface FlexibleDefinition { defaultMinutes: number; minMinutes: number; maxMinutes: number }

const FLEXIBLE: Record<'study' | 'rest' | 'read_book', FlexibleDefinition> = {
    study: { defaultMinutes: 60, minMinutes: 25, maxMinutes: 120 },
    rest: { defaultMinutes: 30, minMinutes: 15, maxMinutes: 120 },
    read_book: { defaultMinutes: 30, minMinutes: 15, maxMinutes: 90 },
};

/** 同一输入得到同一裁决。事件只应在 endedAt 已经过后再交给 WorldState.recordEvents。 */
export function judgeAction(intent: ActionIntent, context: ActionContext): ActionVerdict {
    const start = intent.startedAt;
    if (!intent.id.trim() || !Number.isFinite(start.getTime())) return failed(intent, 'invalid_time');
    if (context.events?.some(event => event.id === intent.id.trim())) return failed(intent, 'already_done');

    if (intent.kind === 'sleep') return fixedAction(intent, sleepSpan(start, context.schedule), '在宿舍睡觉', context);
    if (intent.kind === 'eat') {
        const meal = context.world?.routine?.meals.find(item => sameInstant(item.start, start));
        const subject = meal?.kind;
        if (!meal) return failed(intent, 'unavailable');
        if (alreadyDid(context, intent.kind, start, subject)) return failed(intent, 'already_done');
        const where = meal.where === 'canteen' ? '在食堂' : meal.where === 'takeout' ? '点了外卖，在' : '在家';
        return fixedAction({ ...intent, subject }, { start: meal.start, end: meal.end }, `${where}吃${meal.kind === 'lunch' ? '午饭' : '晚饭'}`, context);
    }
    if (intent.kind === 'attend_class') {
        const lesson = classesOn(context.schedule, start).lessons.find(item => sameInstant(item.start, start));
        if (!lesson) return failed(intent, 'missing_target');
        const subject = lesson.id ?? lesson.name;
        if (alreadyDid(context, intent.kind, start, subject)) return failed(intent, 'already_done');
        return fixedAction({ ...intent, subject }, { start: lesson.start, end: lesson.end }, `在上${lesson.name ?? '课'}`, context, true);
    }

    const definition = FLEXIBLE[intent.kind];
    const requested = intent.durationMinutes ?? definition.defaultMinutes;
    if (!Number.isInteger(requested) || requested < definition.minMinutes || requested > definition.maxMinutes) return failed(intent, 'invalid_time');
    if (stateAt(context.schedule, start).activity.kind !== 'free') return failed(intent, 'unavailable');

    let subject = intent.subject?.trim() || undefined;
    let occupation = intent.kind === 'study' ? `在学习${subject ? `（${subject}）` : ''}` : intent.kind === 'rest' ? '在休息' : '';
    if (intent.kind === 'read_book') {
        const book = findBook(context.books ?? [], subject);
        if (!book) return failed(intent, 'missing_target');
        const progress = bookProgressAt(context.schedule, book, start);
        if (progress.stopped || progress.finished) return failed(intent, 'unavailable');
        subject = book.id;
        occupation = `在看《${book.title}》`;
    }

    const nominalEnd = addMinutes(start, requested);
    const collision = firstCollision(start, nominalEnd, context);
    if (collision && collision.start <= start) return failed(intent, 'conflict');
    const end = collision?.start ?? nominalEnd;
    const actual = minutesBetween(start, end);
    if (actual < definition.minMinutes) return failed(intent, 'no_time');
    return succeeded({ ...intent, subject }, end, occupation, requested, actual, collision ? 'interrupted' : 'succeeded', collision ? 'interrupted_by_commitment' : undefined);
}

/** 未来选择器只能从这里拿动作；需要目标的动作会选择当前真实课程、饭或第一本仍在读的书。 */
export function availableActions(at: Date, context: ActionContext): { kind: TypedActionKind; subject?: string }[] {
    const candidates: ActionIntent[] = [
        { id: 'probe:sleep', kind: 'sleep', startedAt: at },
        { id: 'probe:eat', kind: 'eat', startedAt: at },
        { id: 'probe:class', kind: 'attend_class', startedAt: at },
        { id: 'probe:study', kind: 'study', startedAt: at },
        { id: 'probe:rest', kind: 'rest', startedAt: at },
        ...((context.books ?? []).map(book => ({ id: `probe:read:${book.id}`, kind: 'read_book' as const, startedAt: at, subject: book.id }))),
    ];
    return candidates.flatMap(candidate => {
        const verdict = judgeAction(candidate, context);
        return verdict.ok ? [{ kind: candidate.kind, ...(verdict.event.subject ? { subject: verdict.event.subject } : {}) }] : [];
    }).filter((item, index, all) => all.findIndex(other => other.kind === item.kind && other.subject === item.subject) === index);
}

/** 已落账的类型化行动在某时刻对应的占用；状态行接入留给事件执行器批次。 */
export function typedOccupation(event: LifeEvent, at: Date, books: readonly ReadingBook[] = []): string | undefined {
    if (event.result === 'failed' || at < new Date(event.startedAt) || at >= new Date(event.endedAt)) return undefined;
    switch (event.kind as TypedActionKind) {
        case 'sleep': return '在宿舍睡觉';
        case 'eat': return event.subject === 'lunch' ? '在吃午饭' : '在吃晚饭';
        case 'attend_class': return `在上${event.subject ?? '课'}`;
        case 'study': return `在学习${event.subject ? `（${event.subject}）` : ''}`;
        case 'rest': return '在休息';
        case 'read_book': {
            const book = books.find(item => item.id === event.subject);
            return `在看${book ? `《${book.title}》` : '书'}`;
        }
        default: return undefined;
    }
}

function fixedAction(intent: ActionIntent, span: { start: Date; end: Date } | undefined, occupation: string,
    context: ActionContext, ignoresFlexible = false): ActionVerdict {
    if (!span || !sameInstant(span.start, intent.startedAt)) return failed(intent, 'unavailable');
    if (!ignoresFlexible && firstExistingCollision(span.start, span.end, context.events)) return failed(intent, 'conflict');
    const minutes = minutesBetween(span.start, span.end);
    return succeeded(intent, span.end, occupation, minutes, minutes, 'succeeded');
}

function succeeded(intent: ActionIntent, end: Date, occupation: string, requestedMinutes: number, actualMinutes: number,
    result: 'succeeded' | 'interrupted', reason?: string): ActionVerdict {
    const subject = intent.subject?.trim() || undefined;
    return {
        ok: true,
        event: {
            id: intent.id.trim(), kind: intent.kind, startedAt: intent.startedAt.toISOString(), at: end.toISOString(),
            source: intent.source ?? 'simulation', result,
            ...(subject ? { subject } : {}), ...(reason ? { reason } : {}),
        },
        occupation, requestedMinutes, actualMinutes,
    };
}

function failed(intent: ActionIntent, reason: ActionFailure): ActionVerdict {
    const valid = Number.isFinite(intent.startedAt.getTime());
    const at = valid ? intent.startedAt.toISOString() : new Date(0).toISOString();
    return {
        ok: false,
        event: {
            id: intent.id.trim() || 'invalid-action', kind: intent.kind, startedAt: at, at,
            source: intent.source ?? 'simulation', result: 'failed', reason,
            ...(intent.subject?.trim() ? { subject: intent.subject.trim() } : {}),
        },
        reason,
    };
}

/** 作息上的入睡时刻之前多久以内可以去睡：她 02:00 睡，22:30 以后早点睡、熬到一两点都行（DSH 行动复核 1.5：原来只能正好 02:00 睡） */
export const EARLY_BED_MINUTES = 210;

function sleepSpan(start: Date, schedule: Schedule): { start: Date; end: Date } | undefined {
    const state = stateAt(schedule, start);
    // 过了入睡时刻、还没到起床（醒了又睡）：睡到该起的时候
    if (state.activity.kind === 'sleep') return { start, end: state.activity.until };
    const [hour, minute] = schedule.sleep.split(':').map(Number);
    const bedtime = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute);
    if (bedtime <= start) bedtime.setDate(bedtime.getDate() + 1);
    if (minutesBetween(start, bedtime) > EARLY_BED_MINUTES) return undefined;
    const night = stateAt(schedule, bedtime);
    return night.activity.kind === 'sleep' ? { start, end: night.activity.until } : undefined;
}

function firstCollision(start: Date, end: Date, context: ActionContext): { start: Date; end: Date } | undefined {
    const fixed: { start: Date; end: Date }[] = [];
    fixed.push(...classesOn(context.schedule, start).lessons);
    fixed.push(...(context.world?.routine?.meals ?? []));
    const [sleepHour, sleepMinute] = context.schedule.sleep.split(':').map(Number);
    const sleep = new Date(start.getFullYear(), start.getMonth(), start.getDate(), sleepHour, sleepMinute);
    if (sleep <= start) sleep.setDate(sleep.getDate() + 1);
    fixed.push({ start: sleep, end: addMinutes(sleep, 12 * 60) });
    for (const event of context.events ?? []) {
        if (event.result !== 'failed') fixed.push({ start: new Date(event.startedAt), end: new Date(event.endedAt) });
    }
    return fixed.filter(item => item.start < end && item.end > start).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
}

function firstExistingCollision(start: Date, end: Date, events: readonly LifeEvent[] | undefined): LifeEvent | undefined {
    return events?.find(event => event.result !== 'failed' && new Date(event.startedAt) < end && new Date(event.endedAt) > start);
}

/** 同一天做过了：按她的一天算（和事件账的 day 一样，02:00 前算前一天），不按日历日 */
function alreadyDid(context: ActionContext, kind: TypedActionKind, at: Date, subject?: string): boolean {
    const day = formatDate(herDay(context.schedule, at));
    return Boolean(context.events?.some(event => event.result === 'succeeded' && event.kind === kind && event.day === day
        && (!subject || !event.subject || event.subject === subject)));
}

function findBook(books: readonly ReadingBook[], subject: string | undefined): ReadingBook | undefined {
    if (!subject) return undefined;
    const text = subject.toLowerCase();
    return books.find(book => [book.id, book.title, ...book.aliases].some(term => term.toLowerCase() === text));
}

function sameInstant(a: Date, b: Date): boolean { return a.getTime() === b.getTime(); }
function addMinutes(at: Date, minutes: number): Date { return new Date(at.getTime() + minutes * 60_000); }
function minutesBetween(start: Date, end: Date): number { return (end.getTime() - start.getTime()) / 60_000; }
