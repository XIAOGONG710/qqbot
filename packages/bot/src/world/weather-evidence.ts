// 天气证据裁决：预报只说明“可能发生”，实况、用户和设备观察才说明“已经发生”。
// 这里只统一事实，不决定她要不要改变计划或主动说话。

import { resolveWorldFact, type FactResolution, type SourcedFact } from './fact-resolution.ts';
import type { WorldEvent } from './events.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { DayWeather, Place, WeatherFetcher, WeatherFetcherStatus } from './weather.ts';

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

interface WeatherEvidenceFile { version: 1; evidence: WeatherEvidence[] }
export interface WeatherEvidenceLedger {
    evidence(): readonly WeatherEvidence[];
    append(item: WeatherEvidence): boolean;
}

const KEEP_MS = 7 * 86_400_000;
export const USER_WEATHER_EVIDENCE_MS = 60 * 60_000;

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

/** 用户和设备观察的持久账；供应商事实由天气缓存即时投影，不重复落两份。 */
export function readWeatherEvidenceLedger(path: string, log: (message: string) => void = () => undefined): WeatherEvidenceLedger {
    mkdirSync(dirname(path), { recursive: true });
    const loaded = readJsonOr<WeatherEvidenceFile>(path, { version: 1, evidence: [] }, log, {
        validate: (value): value is WeatherEvidenceFile => Boolean(value && typeof value === 'object'
            && (value as Partial<WeatherEvidenceFile>).version === 1 && Array.isArray((value as Partial<WeatherEvidenceFile>).evidence)
            && (value as WeatherEvidenceFile).evidence.every(validWeatherEvidence)),
        invalid: 'quarantine', label: '天气证据账',
    });
    let items = loaded.evidence;
    return {
        evidence: () => items,
        append: item => {
            if (!validWeatherEvidence(item)) return false;
            const id = `${item.location}|${item.kind}|${item.sourceId}|${item.observedAt}|${item.condition}`;
            if (items.some(existing => `${existing.location}|${existing.kind}|${existing.sourceId}|${existing.observedAt}|${existing.condition}` === id)) return false;
            const sameSource = items.filter(existing => existing.location === item.location && existing.sourceId === item.sourceId && existing.kind === item.kind);
            if (sameSource.some(existing => Date.parse(existing.observedAt) > Date.parse(item.observedAt))) return false;
            const cutoff = Date.parse(item.observedAt) - KEEP_MS;
            items = [...items.filter(existing => Date.parse(existing.validUntil) >= cutoff
                && !(existing.location === item.location && existing.sourceId === item.sourceId && existing.kind === item.kind)), item]
                .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
            writeJsonAtomic(path, { version: 1, evidence: items } satisfies WeatherEvidenceFile);
            return true;
        },
    };
}

export type WeatherObservationTarget = 'user' | 'current' | 'school' | 'home';
export interface ParsedWeatherObservation { target: WeatherObservationTarget; condition: WeatherCondition }

/** 只收明确的第一现场陈述；疑问、转述预报和没有地点归属的话不猜。 */
export function parseWeatherObservation(text: string): ParsedWeatherObservation | undefined {
    const line = text.trim();
    if (!line || /[?？]|(?:吗|嘛|么)[呀啊呢]?$/.test(line) || /预报|天气软件|软件说|听说/.test(line)) return undefined;
    const targets = [
        [/我(?:们)?这(?:里|边)/, 'user'],
        [/你(?:的)?学校(?:那边)?|学校那边/, 'school'],
        [/你(?:的)?(?:家|老家)(?:那边)?/, 'home'],
        [/你那边/, 'current'],
    ] as const;
    const matched = targets.filter(([pattern]) => pattern.test(line)).map(([, target]) => target);
    if (matched.length !== 1) return undefined;
    const target = matched[0]!;
    if (/没(?:有)?(?:在)?下(?:雨|雪)|没有(?:雨|雪)|雨停了|雪停了/.test(line)) return { target, condition: 'dry' };
    if (/(?:正在|开始|刚开始|在)?下(?:着)?雨|下雨了/.test(line)) return { target, condition: 'rain' };
    if (/(?:正在|开始|在)?下(?:着)?雪|下雪了/.test(line)) return { target, condition: 'snow' };
    if (/(?:有|起)雾|雾很大/.test(line)) return { target, condition: 'fog' };
    return undefined;
}

export function userWeatherEvidence(location: string, condition: WeatherCondition, observedAt: Date, sourceId = 'owner-report'): WeatherEvidence | undefined {
    if (!Number.isFinite(observedAt.getTime())) return undefined;
    const item: WeatherEvidence = {
        location, condition, sourceId, kind: 'user', observedAt: observedAt.toISOString(),
        validUntil: new Date(observedAt.getTime() + USER_WEATHER_EVIDENCE_MS).toISOString(), confidence: 1,
    };
    return validWeatherEvidence(item) ? item : undefined;
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

const rainy = (condition: WeatherCondition) => ['rain', 'snow', 'sleet', 'hail', 'storm'].includes(condition);
const conditionText: Record<WeatherCondition, string> = {
    dry: '无降水', rain: '下雨', snow: '下雪', sleet: '下雨夹雪', hail: '下冰雹', fog: '有雾', storm: '打雷下雨',
};
const conditionFrom = (weather: DayWeather, at: Date): WeatherCondition | undefined => {
    const text = weather.now?.text;
    if (!text) return undefined;
    if (/雷/.test(text)) return 'storm';
    if (/冰雹/.test(text)) return 'hail';
    if (/雨夹雪|冻雨/.test(text)) return 'sleet';
    if (/雪/.test(text)) return 'snow';
    if (/雨/.test(text) || weather.rainHours?.includes(at.getHours())) return 'rain';
    if (/雾/.test(text)) return 'fog';
    return 'dry';
};

function serviceEvidence(place: Place, weather: DayWeather | undefined, status: WeatherFetcherStatus, at: Date): WeatherEvidence[] {
    const placeStatus = status.places[place];
    if (!weather?.real || !placeStatus?.fetchedAt || placeStatus.stale) return [];
    const condition = conditionFrom(weather, at);
    if (!condition) return [];
    const validUntil = new Date(Date.parse(placeStatus.fetchedAt) + status.cacheMaxAgeMs).toISOString();
    const items: WeatherEvidence[] = [{
        location: place, condition, sourceId: status.provider, kind: 'service', observedAt: placeStatus.fetchedAt,
        validUntil, confidence: 0.7,
    }];
    if (weather.laterHour !== undefined) items.push({
        location: place, condition: 'rain', sourceId: status.provider, kind: 'forecast', observedAt: placeStatus.fetchedAt,
        validUntil: new Date(at.getFullYear(), at.getMonth(), at.getDate(), weather.laterHour + 1).toISOString(), confidence: 0.55,
    });
    return items.filter(validWeatherEvidence);
}

/**
 * 现实天气唯一读口：当前日必须经过证据裁决；缓存过期、冲突或无事实时返回未知，禁止上层回退模拟天气。
 * 历史事实保持冻结，未来日仍只是预报，不会被标成“已经发生”。
 */
export function reconciledWeather(base: WeatherFetcher, ledger: WeatherEvidenceLedger): WeatherFetcher {
    return {
        authoritative: true,
        fallbackToSimulation: (date, until) => {
            const today = `${String(until.getFullYear()).padStart(4, '0')}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`;
            return date < today;
        },
        refresh: () => base.refresh(),
        status: () => base.status(),
        day: (place, date, until) => {
            const projected = base.day(place, date, until);
            const today = `${String(until.getFullYear()).padStart(4, '0')}-${String(until.getMonth() + 1).padStart(2, '0')}-${String(until.getDate()).padStart(2, '0')}`;
            if (date !== today) return projected;
            const status = base.status();
            const resolution = resolveWeather([...ledger.evidence(), ...serviceEvidence(place, projected, status, until)], place, until.getTime());
            if (resolution.actual.status !== 'fresh' || !projected) return undefined;
            const condition = resolution.actual.value;
            const hours = new Set(projected.rainHours ?? []);
            if (rainy(condition)) hours.add(until.getHours()); else hours.delete(until.getHours());
            const rainHours = [...hours].sort((left, right) => left - right);
            return {
                ...projected, rain: rainHours.length > 0, rainHours,
                now: { text: conditionText[condition], temp: projected.now?.temp ?? Math.round((projected.low + projected.high) / 2) },
            };
        },
    };
}
