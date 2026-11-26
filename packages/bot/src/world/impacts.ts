// 事件影响的最小事实层。
// 影响把“发生了什么”和“她因此该做什么”分开：这里只描述受影响对象及影响方向，
// 认知、动机和活动层以后再消费它。

import type { WorldEvent } from './events.ts';

export const IMPACT_DIRECTIONS = ['positive', 'negative', 'uncertain'] as const;
export type ImpactDirection = (typeof IMPACT_DIRECTIONS)[number];

export interface WorldImpact {
    /** 稳定幂等键；同一事件的不同影响应使用不同 id。 */
    id: string;
    eventId: string;
    /** 受影响实体，例如 user:123、relationship:123、space:room。 */
    target: string;
    /** 影响的方面，例如 commute、safety、connection、availability。 */
    aspect: string;
    direction: ImpactDirection;
    /** 影响程度，0 到 1。 */
    magnitude: number;
    /** 此项评估的可信度，0 到 1。 */
    confidence: number;
    assessedAt: string;
    validUntil?: string;
}

const DIRECTIONS = new Set<string>(IMPACT_DIRECTIONS);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validWorldImpact(value: unknown): value is WorldImpact {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const impact = value as Partial<WorldImpact>;
    if (!nonEmpty(impact.id) || !nonEmpty(impact.eventId) || !nonEmpty(impact.target) || !nonEmpty(impact.aspect)
        || !DIRECTIONS.has(impact.direction as string) || !unit(impact.magnitude) || !unit(impact.confidence)
        || !timestamp(impact.assessedAt)) return false;
    return impact.validUntil === undefined || (timestamp(impact.validUntil) && Date.parse(impact.validUntil) >= Date.parse(impact.assessedAt));
}

/** 只接受实际存在的事件；同一影响 id 首写获胜，避免后续评估悄悄改写审计历史。 */
export function appendWorldImpacts(events: readonly WorldEvent[], existing: readonly WorldImpact[], incoming: readonly WorldImpact[]): WorldImpact[] {
    const eventIds = new Set(events.map(event => event.id));
    const byId = new Map<string, WorldImpact>();
    for (const impact of [...existing, ...incoming]) {
        if (!validWorldImpact(impact)) throw new Error(`世界影响格式无效：${impact && typeof impact === 'object' ? String((impact as { id?: unknown }).id ?? 'unknown') : 'unknown'}`);
        if (!eventIds.has(impact.eventId)) throw new Error(`世界影响引用了不存在的事件：${impact.eventId}`);
        if (!byId.has(impact.id)) byId.set(impact.id, impact);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.assessedAt) - Date.parse(b.assessedAt) || a.id.localeCompare(b.id, 'zh-CN'));
}

