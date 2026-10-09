// ADR 0042 影子审计：生活事件账里的类型化行动，和同一时刻对外状态行所依据的规则必须一致。
// 这里只读、只报告，不改变世界；线上真正切换到“从事件账读状态”以前先用模拟器封板。

import { asleepSince } from '../bedtime.ts';
import { readingActivities } from '../her-days.ts';
import { freeAction, type LifeSources } from '../life-selector.ts';
import type { LifeEvent } from '../life-events.ts';
import { herStatus } from '../status-line.ts';
import type { TypedActionKind } from '../actions.ts';

export interface LifeStatusMismatch {
    at: string;
    eventId: string;
    eventKind: string;
    expectedKind?: TypedActionKind;
    status: string;
}

/**
 * 每条已落账行动取中点核对：同一时刻按状态行规则算出的行动类型，应与账本一致。
 * 没有账本行动的短空当不在这里判错；它们可能是赶路、课间或不足最短行动时长的空白。
 */
export function auditLifeStatus(events: readonly LifeEvent[], sources: LifeSources): LifeStatusMismatch[] {
    const reading = readingActivities(sources.books);
    const mismatches: LifeStatusMismatch[] = [];
    for (const event of events) {
        if (!event.id.startsWith('life:') || event.result === 'failed') continue;
        const start = Date.parse(event.startedAt);
        const end = Date.parse(event.endedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const at = new Date(start + Math.floor((end - start) / 2));
        const world = sources.worldAt(at);
        const asleep = asleepSince(sources.schedule, sources.bedtimes?.() ?? [], at);
        const status = herStatus(sources.schedule, at, {
            extraFree: reading,
            ...(world ? { world } : {}),
            ...(asleep ? { asleep } : {}),
            plans: {
                plans: sources.plans,
                ...(sources.bodyAt ? { body: sources.bodyAt(at) } : {}),
            },
        });
        const expectedKind = statusKind(status, at, sources, reading);
        if (expectedKind !== event.kind) {
            mismatches.push({
                at: at.toISOString(),
                eventId: event.id,
                eventKind: event.kind,
                ...(expectedKind ? { expectedKind } : {}),
                status: describeActivity(status.state.activity),
            });
        }
    }
    return mismatches;
}

function statusKind(status: ReturnType<typeof herStatus>, at: Date, sources: LifeSources,
    reading: ReturnType<typeof readingActivities>): TypedActionKind | undefined {
    switch (status.state.activity.kind) {
        case 'sleep': return 'sleep';
        case 'class': return 'attend_class';
        case 'between': return undefined;
        case 'free': {
            if (status.busy) {
                if (/吃午饭|吃晚饭/.test(status.busy)) return 'eat';
                if (/赶.*作业/.test(status.busy)) return 'study';
                return undefined;
            }
            return status.doing ? freeAction(status.doing, at, sources, reading).kind : undefined;
        }
    }
}

function describeActivity(activity: ReturnType<typeof herStatus>['state']['activity']): string {
    switch (activity.kind) {
        case 'sleep': return 'sleep';
        case 'class': return `class:${activity.lesson.name ?? activity.lesson.id ?? 'unknown'}`;
        case 'between': return 'between';
        case 'free': return `free:${activity.text}`;
    }
}
