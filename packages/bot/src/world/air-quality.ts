// 真实空气质量（ADR 0227）：和天气一样，只读公开数据、落本地缓存；失败或不完整时世界按原有规则继续。
// 只把当前已观测小时投影进世界，不把预报当成她已经经历过的事实。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { cacheAgeMs } from './cache-freshness.ts';
import { sanitizeExternalError } from './external-error.ts';
import { PLACES, type Place } from './weather.ts';

export interface HourAirQuality { pm25: number; pm10: number; aqi: number; o?: 1 }
export interface DayAirQuality { pm25: number; pm10: number; aqi: number; category: string; observedAt: string; real: true }
export interface RealAirQuality { day(place: Place, date: string, until: Date): DayAirQuality | undefined }

export interface AirQualityStore { since: string; fetchedAt: string; hours: Record<string, HourAirQuality> }

const validCalendarDate = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function isAirQualityStore(value: unknown): value is AirQualityStore {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const store = value as Partial<AirQualityStore>;
    if (!validCalendarDate(store.since) || typeof store.fetchedAt !== 'string' || !Number.isFinite(Date.parse(store.fetchedAt))) return false;
    if (!store.hours || typeof store.hours !== 'object' || Array.isArray(store.hours)) return false;
    const hours = Object.entries(store.hours);
    return hours.length > 0 && hours.every(([key, item]) => {
        if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(key)
            || !item || typeof item !== 'object' || Array.isArray(item)) return false;
        const row = item as Partial<HourAirQuality>;
        return Number.isFinite(row.pm25) && row.pm25! >= 0 && row.pm25! <= 2_000
            && Number.isFinite(row.pm10) && row.pm10! >= 0 && row.pm10! <= 2_000
            && Number.isFinite(row.aqi) && row.aqi! >= 0 && row.aqi! <= 500
            && (row.o === undefined || row.o === 1);
    });
}

export function readAirQualityStore(path: string, log?: (message: string) => void, invalid: 'quarantine' | 'throw' = 'quarantine'): AirQualityStore | undefined {
    return readJsonOr<AirQualityStore | undefined>(path, undefined, log, {
        validate: (value): value is AirQualityStore | undefined => isAirQualityStore(value),
        invalid,
        label: '空气质量缓存',
    });
}

let current: RealAirQuality | undefined;
/** 线上（app.ts）开；模拟器、测试不开。 */
export function useRealAirQuality(source: RealAirQuality | undefined): void { current = source; }
export function realAirQuality(): RealAirQuality | undefined { return current; }

const MIN_HOURS = 12;
const MAX_HOURS = 24 * 14;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const hourKey = (time: Date) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}`;
const dateOf = (time: Date) => hourKey(time).slice(0, 10);
const dayAfter = (date: string) => dateOf(new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1));

export function airQualityCategory(aqi: number): string {
    if (aqi <= 50) return '优';
    if (aqi <= 100) return '良';
    if (aqi <= 150) return '轻度污染';
    if (aqi <= 200) return '中度污染';
    if (aqi <= 300) return '重度污染';
    return '严重污染';
}

export function parseOpenMeteoAirQuality(data: unknown): Record<string, HourAirQuality> {
    const hourly = (data as { hourly?: Record<string, unknown> } | null)?.hourly;
    const times = hourly?.time;
    const pm25 = hourly?.pm2_5;
    const pm10 = hourly?.pm10;
    const aqi = hourly?.us_aqi;
    if (!Array.isArray(times) || !Array.isArray(pm25) || !Array.isArray(pm10) || !Array.isArray(aqi)
        || times.length !== pm25.length || times.length !== pm10.length || times.length !== aqi.length
        || times.length > MAX_HOURS) throw new Error('回复里没有合法的逐小时空气质量数据');
    const hours: Record<string, HourAirQuality> = {};
    times.forEach((time, i) => {
        if (typeof time !== 'string' || typeof pm25[i] !== 'number' || typeof pm10[i] !== 'number' || typeof aqi[i] !== 'number') return;
        hours[time.slice(0, 13)] = { pm25: pm25[i] as number, pm10: pm10[i] as number, aqi: aqi[i] as number };
    });
    return hours;
}

function validHourly(value: unknown): Record<string, HourAirQuality> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('供应商返回的空气质量不是对象');
    const output: Record<string, HourAirQuality> = {};
    for (const [key, item] of Object.entries(value)) {
        if (Object.keys(output).length >= MAX_HOURS) throw new Error('供应商返回的空气质量时数过多');
        if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(key)) continue;
        const row = item as Partial<HourAirQuality> | null;
        if (!row || typeof row !== 'object' || !Number.isFinite(row.pm25) || !Number.isFinite(row.pm10) || !Number.isFinite(row.aqi)) continue;
        if (row.pm25! < 0 || row.pm25! > 2_000 || row.pm10! < 0 || row.pm10! > 2_000 || row.aqi! < 0 || row.aqi! > 500) continue;
        output[key] = { pm25: row.pm25!, pm10: row.pm10!, aqi: row.aqi! };
    }
    if (!Object.keys(output).length) throw new Error('供应商没有返回有效空气质量小时');
    return output;
}

function requireCurrentDayCoverage(hours: Readonly<Record<string, HourAirQuality>>, fetchedAt: Date): void {
    const date = dateOf(fetchedAt);
    for (let hour = 0; hour < 24; hour++) {
        if (!hours[`${date}T${pad(hour)}`]) throw new Error('供应商返回的当前日空气质量不完整');
    }
}

function firstRealDay(at: Date): string { return at.getHours() < 5 ? dateOf(at) : dayAfter(dateOf(at)); }

function mergeHours(stored: Readonly<Record<string, HourAirQuality>>, fetched: Readonly<Record<string, HourAirQuality>>, fetchedAt: Date): Record<string, HourAirQuality> {
    const nowKey = hourKey(fetchedAt);
    const today = dateOf(fetchedAt);
    const merged: Record<string, HourAirQuality> = { ...stored };
    const storedPerDay = new Map<string, number>();
    for (const key of Object.keys(stored)) storedPerDay.set(key.slice(0, 10), (storedPerDay.get(key.slice(0, 10)) ?? 0) + 1);
    for (const [key, row] of Object.entries(fetched)) {
        if (merged[key]?.o) continue;
        const date = key.slice(0, 10);
        if (date < today && (storedPerDay.get(date) ?? 0) < MIN_HOURS) continue;
        merged[key] = key <= nowKey ? { ...row, o: 1 } : { ...row };
    }
    return merged;
}

function dayFrom(hours: Readonly<Record<string, HourAirQuality>>, date: string, until: Date): DayAirQuality | undefined {
    const known = Object.entries(hours).filter(([key, row]) => key.startsWith(`${date}T`) && row);
    if (known.length < MIN_HOURS) return undefined;
    const untilKey = hourKey(until);
    const observed = known.filter(([key, row]) => row.o === 1 && key <= untilKey).sort(([a], [b]) => a.localeCompare(b)).at(-1);
    if (!observed) return undefined;
    const [key, row] = observed;
    return { pm25: Math.round(row.pm25), pm10: Math.round(row.pm10), aqi: Math.round(row.aqi), category: airQualityCategory(row.aqi), observedAt: `${key}:00`, real: true };
}

export interface AirQualityFetcherOptions {
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    fetchJson?: (url: string) => Promise<unknown>;
    timeoutMs?: number;
    cacheMaxAgeMs?: number;
}

export interface AirQualityPlaceStatus { fetchedAt?: string; ageMs?: number; stale?: boolean; hours: number; since?: string; error?: string; errorAt?: string }
export interface AirQualityFetcherStatus { provider: string; cacheMaxAgeMs: number; places: Record<Place, AirQualityPlaceStatus>; fetchedAt?: string }

export interface AirQualityFetcher extends RealAirQuality { refresh(): Promise<void>; status(): AirQualityFetcherStatus }

export function airQualityFetcher(options: AirQualityFetcherOptions): AirQualityFetcher {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 2 * 60 * 60_000;
    const fetchJson = options.fetchJson ?? (async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('空气质量服务响应过大');
        return JSON.parse(text) as unknown;
    });
    mkdirSync(options.dir, { recursive: true });
    const path = (place: Place) => join(options.dir, `${place}.json`);
    const stores = new Map<Place, AirQualityStore | undefined>();
    const errors = new Map<Place, string>();
    const errorAt = new Map<Place, string>();
    let inFlight: Promise<void> | undefined;
    const load = (place: Place): AirQualityStore | undefined => {
        if (!stores.has(place)) {
            stores.set(place, readAirQualityStore(path(place), message => options.log(`真实空气质量：${message}`)));
        }
        return stores.get(place);
    };
    return {
        day: (place, date, until) => {
            const store = load(place);
            if (!store || date < store.since) return undefined;
            const age = cacheAgeMs(store.fetchedAt, now());
            if (age === undefined || age > cacheMaxAgeMs) return undefined;
            return dayFrom(store.hours, date, until);
        },
        refresh: () => {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                for (const place of Object.keys(PLACES) as Place[]) {
                    try {
                        const { latitude, longitude } = PLACES[place];
                        const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${latitude}&longitude=${longitude}`
                            + '&hourly=pm2_5,pm10,us_aqi&past_days=2&forecast_days=2&timezone=Asia%2FShanghai';
                        const at = new Date(now());
                        const fetched = validHourly(parseOpenMeteoAirQuality(await fetchJson(url)));
                        requireCurrentDayCoverage(fetched, at);
                        const old = load(place);
                        const store: AirQualityStore = { since: old?.since ?? firstRealDay(at), fetchedAt: at.toISOString(), hours: mergeHours(old?.hours ?? {}, fetched, at) };
                        writeJsonAtomic(path(place), store);
                        stores.set(place, store);
                        errors.delete(place); errorAt.delete(place);
                    } catch (error) {
                        const reason = sanitizeExternalError(error);
                        errors.set(place, reason); errorAt.set(place, new Date(now()).toISOString());
                        options.log(`真实空气质量：${PLACES[place].name}没取到，照旧不用它（${reason}）`);
                    }
                }
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
        status: () => {
            const places = {} as Record<Place, AirQualityPlaceStatus>;
            let fetchedAt: string | undefined;
            for (const place of Object.keys(PLACES) as Place[]) {
                const store = load(place);
                const item: AirQualityPlaceStatus = { hours: Object.keys(store?.hours ?? {}).length };
                if (store?.fetchedAt) {
                    item.fetchedAt = store.fetchedAt;
                    const age = cacheAgeMs(store.fetchedAt, now());
                    if (age !== undefined) {
                        item.ageMs = age; item.stale = age > cacheMaxAgeMs;
                        fetchedAt = !fetchedAt || store.fetchedAt > fetchedAt ? store.fetchedAt : fetchedAt;
                    } else item.stale = true;
                }
                if (store?.since) item.since = store.since;
                if (errors.has(place)) item.error = errors.get(place);
                if (errorAt.has(place)) item.errorAt = errorAt.get(place);
                places[place] = item;
            }
            return { provider: 'open-meteo-air-quality', cacheMaxAgeMs, places, ...(fetchedAt ? { fetchedAt } : {}) };
        },
    };
}
