// 外部世界来源的统一契约。默认关闭；不允许把聊天正文、精确坐标或账号凭据放进事件账。

import type { WorldEvent, WorldEventSource } from './events.ts';

export const EXTERNAL_SOURCE_KINDS = ['map', 'news', 'short_video', 'campus'] as const;
export type ExternalSourceKind = (typeof EXTERNAL_SOURCE_KINDS)[number];
export interface ExternalSourceConfig {
    id: string;
    kind: ExternalSourceKind;
    enabled: boolean;
    /** 供应商端点或由宿主实现的来源名；不能含密钥。 */
    endpoint?: string;
    /** coarse 只允许城市/区域级，precise 必须由用户明确配置。 */
    locationPrecision: 'none' | 'coarse' | 'precise';
    maxAgeMs: number;
}
export interface ExternalObservation {
    sourceId: string;
    kind: ExternalSourceKind;
    occurredAt: Date;
    /** 已清洗的短标签，不能是供应商正文。 */
    label: string;
    confidence: number;
}
const kinds = new Set<string>(EXTERNAL_SOURCE_KINDS);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export function validExternalSourceConfig(value: unknown): value is ExternalSourceConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Partial<ExternalSourceConfig>;
    return id(item.id) && kinds.has(item.kind as string) && typeof item.enabled === 'boolean'
        && (item.endpoint === undefined || (typeof item.endpoint === 'string' && /^https:\/\//.test(item.endpoint) && !/[?&](?:key|token|secret)=/i.test(item.endpoint)))
        && ['none', 'coarse', 'precise'].includes(item.locationPrecision as string)
        && Number.isFinite(item.maxAgeMs) && item.maxAgeMs! > 0 && item.maxAgeMs! <= 7 * 86_400_000;
}

/** 把适配器的已清洗观察转为事件；原始正文、地点与链接一律不进入 details。 */
export function externalObservationEvent(observation: ExternalObservation, observedAt: Date): WorldEvent | undefined {
    if (!id(observation.sourceId) || !kinds.has(observation.kind) || !Number.isFinite(observation.occurredAt.getTime()) || !Number.isFinite(observedAt.getTime())
        || !observation.label.trim() || observation.label.length > 80 || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) return undefined;
    const source: WorldEventSource = observation.kind === 'campus' ? 'sandbox' : observation.kind === 'news' ? 'society' : 'world';
    const bucket = observation.occurredAt.toISOString().slice(0, 13);
    return { id: `external:${observation.sourceId}:${bucket}:${encodeURIComponent(observation.label)}`, source, kind: `external.${observation.kind}.observed`,
        occurredAt: observation.occurredAt.toISOString(), observedAt: observedAt.toISOString(), status: 'active', subjects: ['self', 'space:current'],
        details: { source: observation.sourceId, label: observation.label }, confidence: observation.confidence };
}
