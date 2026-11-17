// 天气证据裁决：预报只说明“可能发生”，实况、用户和设备观察才说明“已经发生”。
// 这里只统一事实，不决定她要不要改变计划或主动说话。

import { resolveWorldFact, type FactResolution, type SourcedFact } from './fact-resolution.ts';
import type { WorldEvent } from './events.ts';

export const WEATHER_CONDITIONS = ['dry', 'rain', 'snow', 'sleet', 'hail', 'fog', 'storm'] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];
export const WEATHER_EVIDENCE_KINDS = ['forecast', 'service', 'user', 'device'] as const;
export type WeatherEvidenceKind = (typeof WEATHER_EVIDENCE_KINDS)[number];

export interface WeatherEvidence {
    location: string;
    condition: WeatherCondition;
    sourceId: string;
    kind: WeatherEvidenceKind;
    observedAt: string;
    validUntil: string;
    confidence: number;
}

export interface WeatherResolution {
    actual: FactResolution<WeatherCondition>;
    forecast: FactResolution<WeatherCondition>;
}

const safeId = (value: string): boolean => /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const validTime = (value: string): boolean => Number.isFinite(Date.parse(value));
const priority = (item: WeatherEvidence): number => {
    // 让证据种类的优先级区间互不重叠：在地用户纠正 > 在地设备 > 软件实况 > 预报。
    const base: Record<WeatherEvidenceKind, number> = { forecast: 0, service: 100, device: 200, user: 300 };
    return base[item.kind] + Math.round(item.confidence * 10);
};

export function validWeatherEvidence(value: unknown): value is WeatherEvidence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const item = value as Partial<WeatherEvidence>;
    return typeof item.location === 'string' && safeId(item.location)
        && typeof item.sourceId === 'string' && safeId(item.sourceId)
        && (WEATHER_CONDITIONS as readonly unknown[]).includes(item.condition)
        && (WEATHER_EVIDENCE_KINDS as readonly unknown[]).includes(item.kind)
        && typeof item.observedAt === 'string' && validTime(item.observedAt)
        && typeof item.validUntil === 'string' && validTime(item.validUntil)
        && Date.parse(item.validUntil) >= Date.parse(item.observedAt)
        && typeof item.confidence === 'number' && Number.isFinite(item.confidence)
        && item.confidence >= 0 && item.confidence <= 1;
}

function facts(items: readonly WeatherEvidence[], location: string, forecast: boolean): SourcedFact<WeatherCondition>[] {
    return items.filter(validWeatherEvidence).filter(item => item.location === location && (item.kind === 'forecast') === forecast).map(item => ({
        key: `weather.${location}.${forecast ? 'forecast' : 'actual'}`,
        value: item.condition,
        source: item.sourceId,
        observedAt: item.observedAt,
        validUntil: item.validUntil,
        priority: priority(item),
    }));
}

export function resolveWeather(items: readonly WeatherEvidence[], location: string, now = Date.now()): WeatherResolution {
    return {
        actual: resolveWorldFact(`weather.${location}.actual`, facts(items, location, false), { now }),
        forecast: resolveWorldFact(`weather.${location}.forecast`, facts(items, location, true), { now }),
    };
}

/** 只有无冲突的新鲜实况才能成为“天气真正发生”的世界事件。 */
export function observedWeatherEvent(location: string, resolution: WeatherResolution, observedAt: Date): WorldEvent | undefined {
    if (!safeId(location) || !Number.isFinite(observedAt.getTime()) || resolution.actual.status !== 'fresh') return undefined;
    return {
        id: `weather-truth:${location}:${observedAt.toISOString().slice(0, 13)}:${resolution.actual.value}`,
        source: 'world', kind: 'world.weather.truth', occurredAt: resolution.actual.observedAt, observedAt: observedAt.toISOString(),
        validUntil: resolution.actual.validUntil, status: 'active', subjects: ['self', `place:${location}`],
        details: { location, condition: resolution.actual.value, evidenceSource: resolution.actual.source }, confidence: 1,
    };
}
