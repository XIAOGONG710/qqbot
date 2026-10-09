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
        const status = statusAt(at, sources, reading, world);
        // 微信来往是世界里带 person 的确定性小事，不是作息文本；在事件发生后能从同一天世界事实核回对象即可。
        const social = event.kind === 'interact_npc' && world?.events.some(item => item.person?.id === event.target
            && item.at >= new Date(event.startedAt) && item.at <= at);
        const expectedKind = social ? 'interact_npc' : statusKind(status, at, sources, reading);
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

export interface LedgerGap {
    /** 这段空当的开始、结束（账上前一件行动结束、后一件开始） */
    from: string;
    to: string;
    /** 空当里第一个取样点按状态行规则该有的行动 */
    expectedKind: TypedActionKind;
    status: string;
}

/** 执行器本来就不记的空当（ADR 0040：短于 10 分钟的空当不记） */
const MIN_GAP_MS = 10 * 60_000;

/**
 * 反方向（2026-10-09 Claude 复核 Codex 接管）：每 stepMinutes 取一次状态行，状态行说她在做某件事（睡觉、上课、吃饭、学习、空闲里实际在做的），
 * 账上那一刻却没有任何行动的，记一条「账上缺」——不然状态行对外说她在修片，账上那两个小时是空的，查不出来。
 * 只看第一件行动开始到最后一件结束之间（执行器还没排到的尾巴不算）；短于 10 分钟的空当不算；同一段空当只记一条。
 */
export function auditLedgerCoverage(events: readonly LifeEvent[], sources: LifeSources, stepMinutes = 15): LedgerGap[] {
    const spans = events
        .filter(event => event.id.startsWith('life:') && event.result !== 'failed')
        .map(event => [Date.parse(event.startedAt), Date.parse(event.endedAt)] as const)
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
        .sort((a, b) => a[0] - b[0]);
    if (spans.length === 0) return [];
    const reading = readingActivities(sources.books);
    const step = stepMinutes * 60_000;
    const first = spans[0]![0];
    const last = Math.max(...spans.map(([, end]) => end));
    const gaps: LedgerGap[] = [];
    for (let t = Math.ceil(first / step) * step; t < last; t += step) {
        if (spans.some(([start, end]) => start <= t && t < end)) continue;
        const before = Math.max(first, ...spans.filter(([, end]) => end <= t).map(([, end]) => end));
        const after = Math.min(...spans.filter(([start]) => start > t).map(([start]) => start));
        if (after - before < MIN_GAP_MS) continue;
        const from = new Date(before).toISOString();
        if (gaps.at(-1)?.from === from) continue;
        const at = new Date(t);
        const status = statusAt(at, sources, reading, sources.worldAt(at));
        const expectedKind = statusKind(status, at, sources, reading);
        if (expectedKind) gaps.push({ from, to: new Date(after).toISOString(), expectedKind, status: describeActivity(status.state.activity) });
    }
    return gaps;
}

/** 同一时刻对外的状态行（和 contact.ts 拼提示词用同一个 herStatus） */
function statusAt(at: Date, sources: LifeSources, reading: ReturnType<typeof readingActivities>, world: ReturnType<LifeSources['worldAt']>) {
    const asleep = asleepSince(sources.schedule, sources.bedtimes?.() ?? [], at);
    return herStatus(sources.schedule, at, {
        extraFree: reading,
        ...(world ? { world } : {}),
        ...(asleep ? { asleep } : {}),
        plans: {
            plans: sources.plans,
            ...(sources.bodyAt ? { body: sources.bodyAt(at) } : {}),
        },
    });
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
