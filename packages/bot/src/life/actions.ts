// 类型化行动与世界裁判（ADR 0037）。
// 模型和未来的自主选择器只提交“想做什么”；本模块按真实课表、日常、读书状态和事件账决定能否发生。
// 首刀只把时间当硬资源，不另造一套精力、钱或章节进度，避免和 body.ts、money.ts、her-days.ts 形成双事实源。

import { localDate } from '../local-date.ts';
import { calendarDate, stateTimestamp } from '../memory/state-schema.ts';
import { bookProgressAt, type ReadingBook } from './her-days.ts';
import type { LifeEvent, LifeEventDraft, LifeEventSource } from '.././world/life-events.ts';
import { dishNote } from './menu.ts';
import { atHome, classesOn, formatDate, herDay, stateAt, type Schedule } from './schedule.ts';
import { OCCUPATION_MINUTES, type WorldNow } from '.././world/world.ts';

export type TypedActionKind = 'sleep' | 'eat' | 'meet' | 'attend_class' | 'study' | 'rest' | 'read_book' | 'leisure' | 'work_on_project' | 'interact_npc';
export type ActionFailure = 'invalid_time' | 'unavailable' | 'conflict' | 'no_time' | 'missing_target' | 'already_done';
/**
 * 灵活的行动做到一半停下的原因（ADR 0042）：硬事件打断——要去上课了、得赶作业了（写完之前那一段）；
 * 别的（饭点、世界里的事、睡觉、已经排了的事）照旧是 interrupted_by_commitment（ADR 0037，旧数据里就是这个）
 */
export type Interruption = 'interrupted_by_class' | 'interrupted_by_deadline' | 'interrupted_by_commitment';
/** 赶作业抢得走的：休闲、躺着、看闲书；本来就在学习的接着学 */
const DEADLINE_PREEMPTS = new Set<TypedActionKind>(['leisure', 'rest', 'read_book', 'work_on_project']);

export interface ActionIntent {
    id: string;
    kind: TypedActionKind;
    startedAt: Date;
    source?: LifeEventSource;
    subject?: string;
    /** 长期项目 ID 或 NPC ID；不把显示名当稳定标识。 */
    target?: string;
    /** 赴约同时吃了一顿饭；需要值在行动完成时按吃饭结算。 */
    meal?: boolean;
    durationMinutes?: number;
}

/** 从约定存储映射出的硬时段；只有这里列出的赴约才能通过裁判。 */
export interface ActionAppointment {
    id: string;
    start: Date;
    end: Date;
    subject: string;
    target: string;
    meal: boolean;
}

export interface ActionContext {
    schedule: Schedule;
    world?: WorldNow;
    books?: readonly ReadingBook[];
    events?: readonly LifeEvent[];
    appointments?: readonly ActionAppointment[];
    /** 世界里别的有时长的事（洗澡、喂猫、取快递、和家里视频，ADR 0030、0031）：不记成行动，但占着时间，灵活的行动撞上就停（ADR 0040） */
    busy?: readonly { start: Date; end: Date }[];
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

const FLEXIBLE: Record<'study' | 'rest' | 'read_book' | 'leisure' | 'work_on_project' | 'interact_npc', FlexibleDefinition> = {
    study: { defaultMinutes: 60, minMinutes: 25, maxMinutes: 120 },
    rest: { defaultMinutes: 30, minMinutes: 15, maxMinutes: 120 },
    read_book: { defaultMinutes: 30, minMinutes: 15, maxMinutes: 90 },
    // 休闲（ADR 0040）：追剧、打游戏、刷手机、修片子……做什么写在 subject 里，就是状态行那几个字
    leisure: { defaultMinutes: 60, minMinutes: 10, maxMinutes: 240 },
    work_on_project: { defaultMinutes: 60, minMinutes: 15, maxMinutes: 240 },
    interact_npc: { defaultMinutes: 15, minMinutes: 5, maxMinutes: 60 },
};

/** 同一输入得到同一裁决。事件只应在 endedAt 已经过后再交给 WorldState.recordEvents。 */
export function judgeAction(intent: ActionIntent, context: ActionContext): ActionVerdict {
    const start = intent.startedAt;
    if (!intent.id.trim() || !supportedDate(start) || !calendarDate(formatDate(herDay(context.schedule, start)))) return failed(intent, 'invalid_time');
    if (intent.durationMinutes !== undefined && (!Number.isInteger(intent.durationMinutes) || intent.durationMinutes <= 0)) return failed(intent, 'invalid_time');
    if (context.events?.some(event => event.id === intent.id.trim())) return failed(intent, 'already_done');

    if (intent.kind === 'sleep') return fixedAction(intent, sleepSpan(start, context.schedule), atHome(context.schedule, herDay(context.schedule, start)) ? '在家睡觉' : '在宿舍睡觉', context);
    if (intent.kind === 'eat') {
        // 饭点开头开始；见完面回来饭点已经开始了的，从回来那一刻吃（G1）
        const meal = context.world?.routine?.meals.find(item => start >= item.start && start < item.end);
        const subject = meal?.kind;
        if (!meal) return failed(intent, 'unavailable');
        if (alreadyDid(context, intent.kind, start, subject)) return failed(intent, 'already_done');
        const where = meal.where === 'canteen' ? '在食堂' : meal.where === 'takeout' ? '点了外卖，在' : '在家';
        // 要出门赴约的，吃到出门那一刻（G1）；只能比饭点短，不能更长
        const end = intent.durationMinutes ? new Date(Math.min(meal.end.getTime(), start.getTime() + intent.durationMinutes * 60_000)) : meal.end;
        return fixedAction({ ...intent, subject }, { start, end }, `${where}吃${meal.kind === 'lunch' ? '午饭' : '晚饭'}${dishNote(meal.dish)}`, context);
    }
    if (intent.kind === 'meet') {
        const appointment = context.appointments?.find(item => item.id === intent.id && sameInstant(item.start, start));
        if (!appointment) return failed(intent, 'unavailable');
        const occupation = appointment.meal ? `在外面吃饭（${appointment.subject}）` : `在赴约（${appointment.subject}）`;
        return fixedAction({ ...intent, subject: appointment.subject, target: appointment.target, meal: appointment.meal },
            appointment, occupation, context);
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
    const target = intent.target?.trim() || undefined;
    if (['leisure', 'work_on_project', 'interact_npc'].includes(intent.kind) && !subject) return failed(intent, 'missing_target');
    if (['work_on_project', 'interact_npc'].includes(intent.kind) && !target) return failed(intent, 'missing_target');
    let occupation = intent.kind === 'study' ? `在学习${subject ? `（${subject}）` : ''}` : intent.kind === 'rest' ? '在休息'
        : ['leisure', 'work_on_project', 'interact_npc'].includes(intent.kind) ? subject! : '';
    if (intent.kind === 'read_book') {
        const book = findBook(context.books ?? [], subject);
        if (!book) return failed(intent, 'missing_target');
        const progress = bookProgressAt(context.schedule, book, start);
        if (progress.stopped || progress.finished) return failed(intent, 'unavailable');
        subject = book.id;
        occupation = `在看《${book.title}》`;
    }

    const nominalEnd = addMinutes(start, requested);
    const collision = firstCollision(start, nominalEnd, context, DEADLINE_PREEMPTS.has(intent.kind));
    if (collision && collision.start <= start) return failed(intent, 'conflict');
    const end = collision?.start ?? nominalEnd;
    const actual = minutesBetween(start, end);
    if (actual < definition.minMinutes) return failed(intent, 'no_time');
    return succeeded({ ...intent, subject, target }, end, occupation, requested, actual, collision ? 'interrupted' : 'succeeded', collision?.why);
}

/** 写完作业之前在赶的那一段（ADR 0030 的 OCCUPATION_MINUTES.homework）：截止时间是硬事件，休闲撞上就停（ADR 0042） */
export function homeworkSprints(world: WorldNow | undefined): { start: Date; end: Date; course: string }[] {
    return (world?.homework ?? []).map(h => ({ start: addMinutes(h.doneAt, -OCCUPATION_MINUTES.homework), end: h.doneAt, course: h.course }));
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
        case 'meet': return event.meal ? `在外面吃饭${event.subject ? `（${event.subject}）` : ''}` : `在赴约${event.subject ? `（${event.subject}）` : ''}`;
        case 'attend_class': return `在上${event.subject ?? '课'}`;
        case 'study': return `在学习${event.subject ? `（${event.subject}）` : ''}`;
        case 'rest': return '在休息';
        case 'leisure': return event.subject;
        case 'work_on_project': return event.subject;
        case 'interact_npc': return event.subject;
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
    if (!Number.isFinite(span.end.getTime()) || span.end <= span.start) return failed(intent, 'invalid_time');
    if (!ignoresFlexible && firstExistingCollision(span.start, span.end, context.events)) return failed(intent, 'conflict');
    const minutes = minutesBetween(span.start, span.end);
    return succeeded(intent, span.end, occupation, minutes, minutes, 'succeeded');
}

function succeeded(intent: ActionIntent, end: Date, occupation: string, requestedMinutes: number, actualMinutes: number,
    result: 'succeeded' | 'interrupted', reason?: string): ActionVerdict {
    // 队列/事件账只支持四位日历；裁决不能先成功再等落盘时被拒绝。
    if (!supportedDate(end)) return failed(intent, 'invalid_time');
    const subject = intent.subject?.trim() || undefined;
    const target = intent.target?.trim() || undefined;
    return {
        ok: true,
        event: {
            id: intent.id.trim(), kind: intent.kind, startedAt: intent.startedAt.toISOString(), at: end.toISOString(),
            source: intent.source ?? 'simulation', result,
            ...(subject ? { subject } : {}), ...(target ? { target } : {}), ...(intent.meal !== undefined ? { meal: intent.meal } : {}),
            ...(reason ? { reason } : {}),
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
            ...(intent.target?.trim() ? { target: intent.target.trim() } : {}),
            ...(intent.meal !== undefined ? { meal: intent.meal } : {}),
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
    const bedtime = localDate(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute);
    if (bedtime <= start) bedtime.setDate(bedtime.getDate() + 1);
    if (minutesBetween(start, bedtime) > EARLY_BED_MINUTES) return undefined;
    const night = stateAt(schedule, bedtime);
    return night.activity.kind === 'sleep' ? { start, end: night.activity.until } : undefined;
}

/** 先撞上的那件；同一刻开始的，上课、赶作业排在前面（原因写硬事件） */
function firstCollision(start: Date, end: Date, context: ActionContext, deadlines: boolean): { start: Date; end: Date; why: Interruption } | undefined {
    const fixed: { start: Date; end: Date; why: Interruption }[] = [];
    const add = (spans: readonly { start: Date; end: Date }[], why: Interruption) => fixed.push(...spans.map(span => ({ start: span.start, end: span.end, why })));
    add(classesOn(context.schedule, start).lessons, 'interrupted_by_class');
    if (deadlines) add(homeworkSprints(context.world), 'interrupted_by_deadline');
    add(context.world?.routine?.meals ?? [], 'interrupted_by_commitment');
    add(context.busy ?? [], 'interrupted_by_commitment');
    const [sleepHour, sleepMinute] = context.schedule.sleep.split(':').map(Number);
    const sleep = localDate(start.getFullYear(), start.getMonth(), start.getDate(), sleepHour, sleepMinute);
    if (sleep <= start) sleep.setDate(sleep.getDate() + 1);
    add([{ start: sleep, end: addMinutes(sleep, 12 * 60) }], 'interrupted_by_commitment');
    add((context.events ?? []).filter(event => event.result !== 'failed').map(event => ({ start: new Date(event.startedAt), end: new Date(event.endedAt) })), 'interrupted_by_commitment');
    const hard = (why: Interruption) => (why === 'interrupted_by_commitment' ? 1 : 0);
    return fixed.filter(item => item.start < end && item.end > start)
        .sort((a, b) => a.start.getTime() - b.start.getTime() || hard(a.why) - hard(b.why))[0];
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
function supportedDate(at: Date): boolean {
    return Number.isFinite(at.getTime()) && at.getFullYear() >= 0 && at.getFullYear() <= 9999
        && stateTimestamp(at.toISOString());
}
function addMinutes(at: Date, minutes: number): Date { return new Date(at.getTime() + minutes * 60_000); }
function minutesBetween(start: Date, end: Date): number { return (end.getTime() - start.getTime()) / 60_000; }
