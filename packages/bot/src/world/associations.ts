// 事件的联想线索（ADR 0338）。
// 线索不是台词、记忆内容或活动指令；它只保留“之后可以从哪个角度理解这件事”。

import type { WorldEvent } from './events.ts';

export const ASSOCIATION_LANES = ['contextual', 'practical', 'episodic', 'relational', 'reflective'] as const;
export type AssociationLane = (typeof ASSOCIATION_LANES)[number];

export interface WorldAssociation {
    id: string;
    eventId: string;
    lane: AssociationLane;
    /** 受限短标签；不保存原始第三方正文或记忆片段。 */
    focus: string;
    createdAt: string;
    confidence: number;
}

const lanes = new Set<string>(ASSOCIATION_LANES);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validWorldAssociation(value: unknown): value is WorldAssociation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Partial<WorldAssociation>;
    return nonEmpty(item.id) && nonEmpty(item.eventId) && lanes.has(item.lane as string)
        && nonEmpty(item.focus) && item.focus!.length <= 80 && timestamp(item.createdAt) && unit(item.confidence);
}

/** 同一事件同一联想路径首写获胜，防止轮询重复把“想到”记成多次。 */
export function appendWorldAssociations(events: readonly WorldEvent[], existing: readonly WorldAssociation[], incoming: readonly WorldAssociation[]): WorldAssociation[] {
    const eventIds = new Set(events.map(event => event.id));
    const byId = new Map<string, WorldAssociation>();
    for (const association of [...existing, ...incoming]) {
        if (!validWorldAssociation(association)) throw new Error(`世界联想格式无效：${association && typeof association === 'object' ? String((association as { id?: unknown }).id ?? 'unknown') : 'unknown'}`);
        if (!eventIds.has(association.eventId)) throw new Error(`世界联想引用了不存在的事件：${association.eventId}`);
        if (!byId.has(association.id)) byId.set(association.id, association);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

function association(event: WorldEvent, lane: AssociationLane, focus: string): WorldAssociation {
    return { id: `association:${event.id}:${lane}`, eventId: event.id, lane, focus, createdAt: event.observedAt, confidence: event.confidence };
}

/**
 * 为结构化世界事实提供多个解释入口。episodic 只是允许未来的记忆检索器“查有没有相关经历”，
 * 并不表示此刻已经找到了某段回忆，更不会捏造回忆内容。
 */
export function associateWorldEvent(event: WorldEvent): WorldAssociation[] {
    // 私聊正文不在 WorldEvent 中。它只表明一次关系接触到达，不能直接变成关心、催促或外发理由。
    if (event.kind === 'user.message.received') return [association(event, 'relational', '更新关系可用性')];
    if (!event.kind.startsWith('world.') && !event.kind.startsWith('sandbox.') && !event.kind.startsWith('society.') && !event.kind.startsWith('time.')) return [];
    const output = [association(event, 'contextual', '更新当前情境')];
    if (/weather|air|daylight|transport/.test(event.kind)) {
        output.push(association(event, 'practical', '评估环境对安排的影响'));
        output.push(association(event, 'episodic', '按需检索相关经历'));
    } else if (event.source === 'society' || event.kind.includes('holiday')) {
        output.push(association(event, 'reflective', '关联公共日程与个人节律'));
    } else if (event.source === 'sandbox') {
        output.push(association(event, 'practical', '评估当前活动空间'));
    } else if (event.source === 'time') {
        output.push(association(event, 'reflective', '关联时间节律变化'));
    }
    return output;
}
