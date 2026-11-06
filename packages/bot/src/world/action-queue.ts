// 可重放的行动队列（ADR 0037 第二增量、ADR 0038）。
// 计划时只把裁判结果原子写入队列；到 endedAt 后才提交事件账。提交成功再移出队列：
// 若进程在“事件已写、队列未删”的缝隙崩溃，重启会再次提交同一 id，由事件账幂等去重后再清队列。
// DSH 行动复核（10-08）之后：排队时队列里还没结算的计划也算占用；能取消、改时间；事件账不收的挪到死信区，不堵后面的；
// 结算挂在读世界之前（settlingWorld），和世界用同一个时钟。

import type { ActionAppointment, ActionContext, ActionIntent, ActionVerdict, TypedActionKind } from '../life/actions.ts';
import { judgeAction } from '../life/actions.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { LifeEvent, LifeEventDraft } from './life-events.ts';
import { formatDate, herDay, type Schedule } from '../life/schedule.ts';
import type { WorldState } from './world.ts';

export interface QueuedAction {
    id: string;
    kind: TypedActionKind;
    event: LifeEventDraft;
    occupation: string;
    requestedMinutes: number;
    /** 取消（还没开始）的是 0 */
    actualMinutes: number;
    /** 约见本身的开始时刻，和提前出门时刻分开；旧队列可缺省。 */
    meetingAt?: string;
    /** 取消后保留已经出门的事实，但不能再被后续刷新重新延长。 */
    meetingCancelled?: boolean;
}

/** 事件账没收的（格式、日子在开学前、账本的时钟还没到）：留着查，不再重试，也不堵后面的 */
export interface DeadAction extends QueuedAction {
    deadAt: string;
    why: string;
}

export const MAX_DEAD_ACTIONS = 200;

export interface Ledger {
    recordEvents(events: readonly LifeEventDraft[]): void;
    events(): readonly LifeEvent[];
}

export interface ActionQueue {
    /** 同一 id 已排队时原样返回，不重复排；失败裁决不进队列。队列里还没结算的计划也算占用（和事件账里的一样）。 */
    schedule(intent: ActionIntent, context: ActionContext): ActionVerdict;
    /** 最新约定重新裁判同 ID 的未结算见面，保留原开始时刻和稳定身份，更新内容及结束时刻。 */
    refreshMeeting(appointment: ActionAppointment & { meetingAt: Date }, context: ActionContext): ActionVerdict | undefined;
    /**
     * 改时间（作业提前交、换个时间去）：at 时还没开始的计划，按新的开始时间 / 时长重新裁判，同一 id。
     * 裁判不过就保留原计划，返回失败的裁决；没有这条或已经开始了返回 undefined（开始了的用 cancel 打断）
     */
    reschedule(id: string, at: Date, change: { startedAt: Date; durationMinutes?: number }, context: ActionContext): ActionVerdict | undefined;
    /**
     * 取消（下雨、身体不舒服）：at 时还没开始的记成没做成（failed，原因「取消：…」），开始了的在 at 这一刻打断（interrupted，「打断：…」）。
     * 都留在队列里，到 settleDue 再落账；已经做完的返回 undefined
     */
    cancel(id: string, at: Date, reason: string): QueuedAction | undefined;
    /**
     * 提前停（ADR 0042）：开始了的计划在 at 这一刻做完（succeeded，做了的那段算数）——聊天里说她去睡了、下楼喂猫了、作业写完了，世界变了。
     * 和选择器事先知道时一样（到那一刻自然地停），所以不是 interrupted；at 不在开始和结束之间、取消了的返回 undefined
     */
    shorten(id: string, at: Date, why: string, change?: { meal?: boolean; meetingCancelled?: boolean }): QueuedAction | undefined;
    /**
     * 去掉还没落账的计划（ADR 0042）：聊天里说过的事表明那一段她在干别的（说了睡了以后排的休闲），这条计划从来没发生，
     * 不进事件账（和 cancel 不同：cancel 是她本来要做、没做成，她记得）
     */
    drop(id: string, why: string): QueuedAction | undefined;
    /** 依 endedAt 顺序提交到期事件；写账抛错时保留当前及后续项目，下次再试；账本不收的挪到死信区。不抛错。 */
    settleDue(now: Date, ledger: Ledger): number;
    pending(): readonly QueuedAction[];
    dead(): readonly DeadAction[];
}

interface QueueFile { version: 1; items: QueuedAction[]; dead?: DeadAction[] }

export function actionQueue(path: string, log: (message: string) => void = () => undefined): ActionQueue {
    const loaded = readJsonOr<Partial<QueueFile>>(path, {}, message => log(`她的行动队列：${message}`), {
        migrate: value => {
            if (value && typeof value === 'object' && !('version' in value) && Array.isArray((value as { items?: unknown }).items)) {
                return { version: 1, ...value as object };
            }
            return value;
        },
        validate: (value): value is QueueFile => Boolean(value && typeof value === 'object'
            && (value as Partial<QueueFile>).version === 1
            && Array.isArray((value as Partial<QueueFile>).items)
            && ((value as Partial<QueueFile>).dead === undefined || Array.isArray((value as Partial<QueueFile>).dead))),
        invalid: 'throw', label: '行动队列',
    });
    const raw = Array.isArray(loaded.items) ? loaded.items : [];
    let items = raw.filter(validQueuedAction).sort(byEnd);
    if (items.length !== raw.length) log(`她的行动队列：忽略 ${raw.length - items.length} 条格式损坏的计划`);
    let dead = (Array.isArray(loaded.dead) ? loaded.dead : []).filter((item): item is DeadAction =>
        validQueuedAction(item) && typeof (item as DeadAction).deadAt === 'string' && typeof (item as DeadAction).why === 'string').slice(-MAX_DEAD_ACTIONS);
    const commit = (nextItems: QueuedAction[], nextDead = dead) => {
        writeJsonAtomic(path, { version: 1, items: nextItems, ...(nextDead.length ? { dead: nextDead } : {}) });
        // 只有原子写入成功才能发布新内存状态，否则同 ID 重试会把未落盘的计划误当成功。
        items = nextItems;
        dead = nextDead;
    };
    /** 裁判时把队列里别的计划也当成占用（schedule 时 judgeAction 只看事件账） */
    const withPlans = (context: ActionContext, except?: string): ActionContext => ({
        ...context,
        events: [...(context.events ?? []), ...items.filter(item => item.id !== except).map(item => planned(item, context.schedule))],
    });
    const replace = (item: QueuedAction) => {
        commit([...items.filter(other => other.id !== item.id), item].sort(byEnd));
    };

    return {
        schedule: (intent, context) => {
            const existing = items.find(item => item.id === intent.id.trim());
            if (existing) return verdictOf(existing);
            const verdict = judgeAction(intent, withPlans(context));
            if (!verdict.ok) return verdict;
            replace({
                id: verdict.event.id, kind: intent.kind, event: verdict.event, occupation: verdict.occupation,
                requestedMinutes: verdict.requestedMinutes, actualMinutes: verdict.actualMinutes,
            });
            log(`她的行动队列：排入 ${intent.kind}，${new Date(verdict.event.at).toISOString()}`);
            return verdict;
        },
        refreshMeeting: (appointment, context) => {
            const item = items.find(other => other.id === appointment.id);
            if (!item || item.kind !== 'meet' || item.event.result !== 'succeeded' || item.meetingCancelled
                || Date.parse(item.event.startedAt ?? item.event.at) !== appointment.start.getTime()
                || !Number.isFinite(appointment.meetingAt.getTime())) return undefined;
            const verdict = judgeAction({ id: item.id, kind: 'meet', startedAt: appointment.start, source: item.event.source },
                withPlans({ ...context, appointments: [appointment] }, item.id));
            if (!verdict.ok) {
                log(`她的行动队列：见面刷新不行（${verdict.reason}），保留原计划`);
                return verdict;
            }
            const updated: QueuedAction = { ...item, event: verdict.event, occupation: verdict.occupation,
                requestedMinutes: verdict.requestedMinutes, actualMinutes: verdict.actualMinutes,
                meetingAt: appointment.meetingAt.toISOString() };
            if (JSON.stringify(updated) !== JSON.stringify(item)) {
                replace(updated);
                log('她的行动队列：按最新约定刷新见面');
            }
            return verdict;
        },
        reschedule: (id, at, change, context) => {
            const item = items.find(other => other.id === id);
            if (!item || Date.parse(item.event.startedAt ?? item.event.at) <= at.getTime() || item.event.result === 'failed') return undefined;
            const verdict = judgeAction({
                id, kind: item.kind, startedAt: change.startedAt, source: item.event.source,
                ...(item.event.subject ? { subject: item.event.subject } : {}),
                ...(item.event.target ? { target: item.event.target } : {}),
                ...(item.event.meal !== undefined ? { meal: item.event.meal } : {}),
                ...(change.durationMinutes !== undefined ? { durationMinutes: change.durationMinutes } : {}),
            }, withPlans(context, id));
            if (!verdict.ok) {
                log(`她的行动队列：${item.kind} 改到 ${change.startedAt.toISOString()} 不行（${verdict.reason}），照原计划`);
                return verdict;
            }
            replace({ ...item, event: verdict.event, occupation: verdict.occupation, requestedMinutes: verdict.requestedMinutes, actualMinutes: verdict.actualMinutes });
            log(`她的行动队列：${item.kind} 改到 ${change.startedAt.toISOString()}`);
            return verdict;
        },
        cancel: (id, at, reason) => {
            const item = items.find(other => other.id === id);
            if (!item || item.event.result === 'failed' || item.event.reason?.startsWith('打断：')) return undefined;
            const start = Date.parse(item.event.startedAt ?? item.event.at);
            const end = Date.parse(item.event.at);
            if (at.getTime() >= end) return undefined;
            const when = at.toISOString();
            const why = reason.trim() || '改主意了';
            const cancelled: QueuedAction = at.getTime() <= start
                ? { ...item, event: { ...item.event, startedAt: when, at: when, result: 'failed', reason: `取消：${why}` }, actualMinutes: 0 }
                : { ...item, event: { ...item.event, at: when, result: 'interrupted', reason: `打断：${why}` }, actualMinutes: (at.getTime() - start) / 60_000 };
            replace(cancelled);
            log(`她的行动队列：${item.kind}${cancelled.event.result === 'failed' ? '取消' : '打断'}（${why}）`);
            return cancelled;
        },
        shorten: (id, at, why, change) => {
            const item = items.find(other => other.id === id);
            if (!item || item.event.result === 'failed') return undefined;
            const start = Date.parse(item.event.startedAt ?? item.event.at);
            if (at.getTime() <= start || at.getTime() >= Date.parse(item.event.at)) return undefined;
            // 原来被课打断的（interrupted_by_class）提前停了，就不是被课打断的：原因去掉
            const event: LifeEventDraft = { ...item.event, at: at.toISOString(), result: 'succeeded', ...(change?.meal === undefined ? {} : { meal: change.meal }) };
            delete event.reason;
            const shortened: QueuedAction = { ...item, event, actualMinutes: (at.getTime() - start) / 60_000,
                ...(change?.meetingCancelled === undefined ? {} : { meetingCancelled: change.meetingCancelled }) };
            replace(shortened);
            log(`她的行动队列：${item.kind} 提前到 ${at.toISOString()} 停（${why}）`);
            return shortened;
        },
        drop: (id, why) => {
            const item = items.find(other => other.id === id);
            if (!item) return undefined;
            commit(items.filter(other => other.id !== id));
            log(`她的行动队列：去掉 ${item.kind}（${item.id}）：${why}`);
            return item;
        },
        settleDue: (now, ledger) => {
            let settled = 0;
            for (const item of [...items]) {
                if (new Date(item.event.at) > now) break;
                try {
                    ledger.recordEvents([item.event]);
                } catch (error) {
                    // 写盘失败这类一会儿就好的：留着这条和后面的（按结束时间的顺序），下次再试
                    log(`她的行动队列：结算 ${item.kind}（${item.id}）写事件账失败，下次再试：${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
                // recordEvents 以 id 幂等、不收的不报错。只有事实账真的有这条才算结算；没收的挪到死信区，不然每次都卡在这一条
                let accepted: boolean;
                try { accepted = ledger.events().some(event => event.id === item.id); }
                catch (error) {
                    log(`她的行动队列：确认 ${item.kind}（${item.id}）事件账失败，下次再试：${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
                const nextItems = items.filter(other => other.id !== item.id);
                const nextDead = accepted ? dead : [...dead, { ...item, deadAt: now.toISOString(), why: '事件账没收' }].slice(-MAX_DEAD_ACTIONS);
                try { commit(nextItems, nextDead); }
                catch (error) {
                    log(`她的行动队列：结算 ${item.kind}（${item.id}）队列写入失败，下次再试：${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
                if (!accepted) {
                    log(`她的行动队列：${item.kind}（${item.id}）事件账没收，挪到死信区`);
                    continue;
                }
                settled++;
                log(`她的行动队列：结算 ${item.kind}（${item.event.result}）`);
            }
            return settled;
        },
        pending: () => items,
        dead: () => dead,
    };
}

/**
 * 读世界之前先结算到期的行动（DSH 行动复核 3·4）：时间块、状态行、日记、事件账读到的都已经算上做完的事。
 * 用世界自己的时钟（nowFn 和 worldState 的同一个），不另起一个时钟
 */
export function settlingWorld(world: WorldState, queue: ActionQueue, nowFn: () => number, plan?: (now: Date) => void): WorldState {
    // plan：结算之前先把到现在为止该做的排进队列（ADR 0040 的执行器）；它只读不带结算的那一层世界，不会绕回来
    const settle = () => {
        const now = new Date(nowFn());
        plan?.(now);
        queue.settleDue(now, world);
    };
    return {
        at: (herWorld, schedule, now) => { settle(); return world.at(herWorld, schedule, now); },
        note: now => { settle(); world.note(now); },
        record: (contact, episode, drafts) => world.record(contact, episode, drafts),
        recordEvents: drafts => world.recordEvents(drafts),
        actions: () => { settle(); return world.actions(); },
        events: () => { settle(); return world.events(); },
    };
}

/** 队列里的计划当成事件账里的一条（裁判看占用用；日子和账本一样按她的一天、按结束时刻算） */
function planned(item: QueuedAction, schedule: Schedule): LifeEvent {
    return {
        id: item.id, actor: 'linmengyao', kind: item.kind, day: formatDate(herDay(schedule, new Date(item.event.at))),
        startedAt: item.event.startedAt ?? item.event.at, endedAt: item.event.at, source: item.event.source, result: item.event.result,
        ...(item.event.subject ? { subject: item.event.subject } : {}),
        ...(item.event.target ? { target: item.event.target } : {}),
        ...(item.event.meal !== undefined ? { meal: item.event.meal } : {}),
    };
}

function verdictOf(item: QueuedAction): ActionVerdict {
    return {
        ok: true, event: item.event, occupation: item.occupation,
        requestedMinutes: item.requestedMinutes, actualMinutes: item.actualMinutes,
    };
}

const KINDS = new Set<TypedActionKind>(['sleep', 'eat', 'meet', 'attend_class', 'study', 'rest', 'read_book', 'leisure', 'work_on_project', 'interact_npc']);
function validQueuedAction(value: unknown): value is QueuedAction {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<QueuedAction>;
    const event = item.event;
    // 取消了的（还没开始）是 failed、0 分钟；别的至少 1 分钟
    const cancelled = event?.result === 'failed' && item.actualMinutes === 0;
    return typeof item.id === 'string' && item.id.length > 0
        && typeof item.kind === 'string' && KINDS.has(item.kind as TypedActionKind)
        && typeof item.occupation === 'string'
        && typeof item.requestedMinutes === 'number' && item.requestedMinutes > 0
        && typeof item.actualMinutes === 'number' && (item.actualMinutes > 0 || cancelled)
        && (item.meetingAt === undefined || (typeof item.meetingAt === 'string' && Number.isFinite(Date.parse(item.meetingAt))))
        && (item.meetingCancelled === undefined || typeof item.meetingCancelled === 'boolean')
        && Boolean(event) && event!.id === item.id && event!.kind === item.kind
        && typeof event!.startedAt === 'string' && Number.isFinite(Date.parse(event!.startedAt))
        && typeof event!.at === 'string' && Number.isFinite(Date.parse(event!.at))
        && Date.parse(event!.startedAt) <= Date.parse(event!.at)
        && (event!.result === 'succeeded' || event!.result === 'interrupted' || cancelled)
        && (event!.subject === undefined || typeof event!.subject === 'string')
        && (event!.target === undefined || typeof event!.target === 'string')
        && (event!.meal === undefined || typeof event!.meal === 'boolean')
        && (event!.source === 'simulation' || event!.source === 'conversation' || event!.source === 'external');
}

function byEnd(a: QueuedAction, b: QueuedAction): number {
    return Date.parse(a.event.at) - Date.parse(b.event.at) || a.id.localeCompare(b.id);
}
