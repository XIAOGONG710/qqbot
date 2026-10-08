// 可重放的行动队列（ADR 0037 第二增量）。
// 计划时只把裁判结果原子写入队列；到 endedAt 后才提交事件账。提交成功再移出队列：
// 若进程在“事件已写、队列未删”的缝隙崩溃，重启会再次提交同一 id，由事件账幂等去重后再清队列。

import type { ActionContext, ActionIntent, ActionVerdict, TypedActionKind } from './actions.ts';
import { judgeAction } from './actions.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { LifeEvent, LifeEventDraft } from './life-events.ts';

export interface QueuedAction {
    id: string;
    kind: TypedActionKind;
    event: LifeEventDraft;
    occupation: string;
    requestedMinutes: number;
    actualMinutes: number;
}

export interface ActionQueue {
    /** 同一 id 已排队时原样返回，不重复排；失败裁决不进队列。 */
    schedule(intent: ActionIntent, context: ActionContext): ActionVerdict;
    /** 依 endedAt 顺序提交到期事件；commit 抛错时保留当前及后续项目，供下次重试。 */
    settleDue(now: Date, ledger: { recordEvents(events: readonly LifeEventDraft[]): void; events(): readonly LifeEvent[] }): number;
    pending(): readonly QueuedAction[];
}

interface QueueFile { version: 1; items: QueuedAction[] }

export function actionQueue(path: string, log: (message: string) => void = () => undefined): ActionQueue {
    const loaded = readJsonOr<Partial<QueueFile>>(path, {}, message => log(`她的行动队列：${message}`));
    const raw = Array.isArray(loaded.items) ? loaded.items : [];
    let items = raw.filter(validQueuedAction).sort(byEnd);
    if (items.length !== raw.length) log(`她的行动队列：忽略 ${raw.length - items.length} 条格式损坏的计划`);
    const persist = () => writeJsonAtomic(path, { version: 1, items });

    return {
        schedule: (intent, context) => {
            const existing = items.find(item => item.id === intent.id.trim());
            if (existing) return verdictOf(existing);
            const verdict = judgeAction(intent, context);
            if (!verdict.ok) return verdict;
            items = [...items, {
                id: verdict.event.id, kind: intent.kind, event: verdict.event, occupation: verdict.occupation,
                requestedMinutes: verdict.requestedMinutes, actualMinutes: verdict.actualMinutes,
            }].sort(byEnd);
            persist();
            log(`她的行动队列：排入 ${intent.kind}，${new Date(verdict.event.at).toISOString()}`);
            return verdict;
        },
        settleDue: (now, ledger) => {
            let settled = 0;
            for (const item of [...items]) {
                if (new Date(item.event.at) > now) break;
                ledger.recordEvents([item.event]);
                // recordEvents 以 id 幂等。只有事实账真的已有这条，才可以从计划队列删除。
                if (!ledger.events().some(event => event.id === item.id)) {
                    throw new Error(`行动 ${item.id} 未写入事件账`);
                }
                items = items.filter(other => other.id !== item.id);
                persist();
                settled++;
                log(`她的行动队列：结算 ${item.kind}（${item.event.result}）`);
            }
            return settled;
        },
        pending: () => items,
    };
}

function verdictOf(item: QueuedAction): ActionVerdict {
    return {
        ok: true, event: item.event, occupation: item.occupation,
        requestedMinutes: item.requestedMinutes, actualMinutes: item.actualMinutes,
    };
}

const KINDS = new Set<TypedActionKind>(['sleep', 'eat', 'attend_class', 'study', 'rest', 'read_book']);
function validQueuedAction(value: unknown): value is QueuedAction {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<QueuedAction>;
    const event = item.event;
    return typeof item.id === 'string' && item.id.length > 0
        && typeof item.kind === 'string' && KINDS.has(item.kind as TypedActionKind)
        && typeof item.occupation === 'string'
        && typeof item.requestedMinutes === 'number' && item.requestedMinutes > 0
        && typeof item.actualMinutes === 'number' && item.actualMinutes > 0
        && Boolean(event) && event!.id === item.id && event!.kind === item.kind
        && typeof event!.startedAt === 'string' && Number.isFinite(Date.parse(event!.startedAt))
        && typeof event!.at === 'string' && Number.isFinite(Date.parse(event!.at))
        && Date.parse(event!.startedAt) <= Date.parse(event!.at)
        && (event!.result === 'succeeded' || event!.result === 'interrupted')
        && (event!.source === 'simulation' || event!.source === 'conversation' || event!.source === 'external');
}

function byEnd(a: QueuedAction, b: QueuedAction): number {
    return Date.parse(a.event.at) - Date.parse(b.event.at) || a.id.localeCompare(b.id);
}
