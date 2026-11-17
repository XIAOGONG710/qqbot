// 大新闻与校园小信息的统一事实契约。
// 适配器只能交付清洗后的短标签；原文、账号、链接和具体学生身份不得进入世界事件账。

import type { WorldEvent } from './events.ts';

export const INFORMATION_SCOPES = ['global', 'regional', 'campus'] as const;
export type InformationScope = (typeof INFORMATION_SCOPES)[number];
export const INFORMATION_AUTHORITIES = ['official', 'editorial', 'community'] as const;
export type InformationAuthority = (typeof INFORMATION_AUTHORITIES)[number];

export interface InformationObservation {
    sourceId: string;
    scope: InformationScope;
    authority: InformationAuthority;
    occurredAt: Date;
    validUntil: Date;
    /** 已清洗的主题标签，不是供应商原文。 */
    topic: string;
    confidence: number;
}

const safeId = (value: string): boolean => /^[a-z][a-z0-9_-]{0,63}$/.test(value);

/** 大新闻和校园墙都先成为带范围、权威性和有效期的观察，不直接成为主动消息。 */
export function informationObservationEvent(observation: InformationObservation, observedAt: Date): WorldEvent | undefined {
    if (!safeId(observation.sourceId) || !(INFORMATION_SCOPES as readonly unknown[]).includes(observation.scope)
        || !(INFORMATION_AUTHORITIES as readonly unknown[]).includes(observation.authority)
        || !Number.isFinite(observation.occurredAt.getTime()) || !Number.isFinite(observation.validUntil.getTime())
        || observation.validUntil < observation.occurredAt || !Number.isFinite(observedAt.getTime())
        || !observation.topic.trim() || observation.topic !== observation.topic.trim()
        || observation.topic.length > 80 || /[\u0000-\u001f\u007f]/.test(observation.topic)
        || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) return undefined;
    const bucket = observation.occurredAt.toISOString().slice(0, 13);
    const source = observation.scope === 'campus' ? 'sandbox' as const : 'society' as const;
    return {
        id: `information:${observation.sourceId}:${bucket}:${encodeURIComponent(observation.topic)}`,
        source, kind: observation.scope === 'campus' ? 'campus.information.observed' : 'society.news.observed',
        occurredAt: observation.occurredAt.toISOString(), observedAt: observedAt.toISOString(),
        validUntil: observation.validUntil.toISOString(), status: 'active',
        subjects: observation.scope === 'campus' ? ['self', 'space:campus'] : ['self', `scope:${observation.scope}`],
        details: { source: observation.sourceId, scope: observation.scope, authority: observation.authority, topic: observation.topic },
        confidence: observation.confidence,
    };
}
