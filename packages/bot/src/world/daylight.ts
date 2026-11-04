// 真实日照（ADR 0228）：只读公开的日出 / 日落时间，给她的世界一个当前光线阶段。
// 它是环境事实，不创造生活事件；取不到或缓存过期时，世界照旧不写这一块。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { cacheAgeMs } from './cache-freshness.ts';
import { sanitizeExternalError } from './external-error.ts';
import { PLACES, type Place } from './weather.ts';

export type DaylightPhase = '夜间' | '清晨' | '白天' | '傍晚';
export interface Daylight { sunrise: string; sunset: string; phase: DaylightPhase; real: true }
export interface RealDaylight { day(place: Place, date: string, at: Date): Daylight | undefined }

export interface SolarTimes { sunrise: string; sunset: string }
export interface DaylightStore { fetchedAt: string; days: Record<string, SolarTimes> }

let current: RealDaylight | undefined;
/** 线上（app.ts）开；模拟器、测试不开。 */
export function useRealDaylight(source: RealDaylight | undefined): void { current = source; }
export function realDaylight(): RealDaylight | undefined { return current; }

const MAX_DAYS = 31;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const clock = (value: string) => value.slice(11, 16);
const pad = (value: number) => String(value).padStart(2, '0');
const dateOf = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
const dayAfter = (value: Date) => dateOf(new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1));
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_MINUTE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;

const validCalendarDate = (value: string): boolean => {
    if (!DATE_ONLY.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function validSolarTimes(date: string, value: unknown): value is SolarTimes {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const times = value as Partial<SolarTimes>;
    return typeof times.sunrise === 'string' && typeof times.sunset === 'string'
        && DATE_TIME_MINUTE.test(times.sunrise) && DATE_TIME_MINUTE.test(times.sunset)
        && times.sunrise.startsWith(`${date}T`) && times.sunset.startsWith(`${date}T`)
        && times.sunrise < times.sunset;
}

export function isDaylightStore(value: unknown): value is DaylightStore {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const store = value as Partial<DaylightStore>;
    if (typeof store.fetchedAt !== 'string' || !Number.isFinite(Date.parse(store.fetchedAt))
        || !store.days || typeof store.days !== 'object' || Array.isArray(store.days)) return false;
    const days = Object.entries(store.days);
    return days.length > 0 && days.length <= MAX_DAYS
        && days.every(([date, times]) => validCalendarDate(date) && validSolarTimes(date, times));
}

export function readDaylightStore(path: string, log?: (message: string) => void, invalid: 'quarantine' | 'throw' = 'quarantine'): DaylightStore | undefined {
    return readJsonOr<DaylightStore | undefined>(path, undefined, log, {
        validate: (value): value is DaylightStore | undefined => isDaylightStore(value),
        invalid,
        label: '日照缓存',
    });
}

function minutes(value: string): number {
    const [hour = 0, minute = 0] = value.slice(11, 16).split(':').map(Number);
    return hour * 60 + minute;
}

export function daylightPhase(times: SolarTimes, at: Date): DaylightPhase {
    const now = at.getHours() * 60 + at.getMinutes();
    const sunrise = minutes(times.sunrise);
    const sunset = minutes(times.sunset);
    if (now < sunrise - 60) return '夜间';
    if (now < sunrise) return '清晨';
    if (now < sunset - 120) return '白天';
    if (now < sunset) return '傍晚';
    return '夜间';
}

/** Open-Meteo daily.time / sunrise / sunset → 本地日期上的日照时间。 */
export function parseOpenMeteoDaylight(data: unknown): Record<string, SolarTimes> {
    const daily = (data as { daily?: Record<string, unknown> } | null)?.daily;
    const dates = daily?.time;
    const sunrise = daily?.sunrise;
    const sunset = daily?.sunset;
    if (!Array.isArray(dates) || !Array.isArray(sunrise) || !Array.isArray(sunset)
        || dates.length !== sunrise.length || dates.length !== sunset.length || dates.length > MAX_DAYS) {
        throw new Error('回复里没有合法的逐日日照数据');
    }
    const output: Record<string, SolarTimes> = {};
    dates.forEach((date, i) => {
        if (typeof date !== 'string' || !validCalendarDate(date)) return;
        const times = { sunrise: sunrise[i], sunset: sunset[i] };
        if (!validSolarTimes(date, times)) return;
        output[date] = times;
    });
    if (!Object.keys(output).length) throw new Error('供应商没有返回有效的逐日日照');
    return output;
}

export interface DaylightFetcherOptions {
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    fetchJson?: (url: string) => Promise<unknown>;
    timeoutMs?: number;
    cacheMaxAgeMs?: number;
}

export interface DaylightPlaceStatus { fetchedAt?: string; ageMs?: number; stale?: boolean; days: number; from?: string; to?: string; error?: string; errorAt?: string }
export interface DaylightFetcherStatus { provider: string; cacheMaxAgeMs: number; places: Record<Place, DaylightPlaceStatus>; fetchedAt?: string }

export interface DaylightFetcher extends RealDaylight { refresh(): Promise<void>; status(): DaylightFetcherStatus }

export function daylightFetcher(options: DaylightFetcherOptions): DaylightFetcher {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 24 * 60 * 60_000;
    const fetchJson = options.fetchJson ?? (async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('日照服务响应过大');
        return JSON.parse(text) as unknown;
    });
    mkdirSync(options.dir, { recursive: true });
    const path = (place: Place) => join(options.dir, `${place}.json`);
    const stores = new Map<Place, DaylightStore | undefined>();
    const errors = new Map<Place, string>();
    const errorAt = new Map<Place, string>();
    let inFlight: Promise<void> | undefined;
    const load = (place: Place): DaylightStore | undefined => {
        if (!stores.has(place)) {
            stores.set(place, readDaylightStore(path(place), message => options.log(`真实日照：${message}`)));
        }
        return stores.get(place);
    };
    return {
        day: (place, date, at) => {
            const store = load(place);
            if (!store) return undefined;
            const age = cacheAgeMs(store.fetchedAt, now());
            if (age === undefined || age > cacheMaxAgeMs) return undefined;
            const times = store.days[date];
            return times ? { sunrise: clock(times.sunrise), sunset: clock(times.sunset), phase: daylightPhase(times, at), real: true } : undefined;
        },
        refresh: () => {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                for (const place of Object.keys(PLACES) as Place[]) {
                    try {
                        const { latitude, longitude } = PLACES[place];
                        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
                            + '&daily=sunrise,sunset&past_days=2&forecast_days=16&timezone=Asia%2FShanghai';
                        const days = parseOpenMeteoDaylight(await fetchJson(url));
                        const at = new Date(now());
                        // 请求的是过去 2 天 + 未来 16 天；若连当前日和次日都不全，视为截断响应，
                        // 不能用它覆盖仍然可用的完整缓存。
                        if (!days[dateOf(at)] || !days[dayAfter(at)]) throw new Error('日照服务返回不完整（缺少当前日或次日）');
                        const store: DaylightStore = { fetchedAt: at.toISOString(), days };
                        writeJsonAtomic(path(place), store);
                        stores.set(place, store);
                        errors.delete(place); errorAt.delete(place);
                    } catch (error) {
                        const reason = sanitizeExternalError(error);
                        errors.set(place, reason); errorAt.set(place, new Date(now()).toISOString());
                        options.log(`真实日照：${PLACES[place].name}没取到，照旧不写进世界（${reason}）`);
                    }
                }
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
        status: () => {
            const places = {} as Record<Place, DaylightPlaceStatus>;
            let fetchedAt: string | undefined;
            for (const place of Object.keys(PLACES) as Place[]) {
                const store = load(place);
                const dates = Object.keys(store?.days ?? {}).sort();
                const item: DaylightPlaceStatus = { days: dates.length, ...(dates.length ? { from: dates[0], to: dates.at(-1) } : {}) };
                if (store?.fetchedAt) {
                    item.fetchedAt = store.fetchedAt;
                    const age = cacheAgeMs(store.fetchedAt, now());
                    if (age !== undefined) {
                        item.ageMs = age; item.stale = age > cacheMaxAgeMs;
                        fetchedAt = !fetchedAt || store.fetchedAt > fetchedAt ? store.fetchedAt : fetchedAt;
                    } else item.stale = true;
                }
                if (errors.has(place)) item.error = errors.get(place);
                if (errorAt.has(place)) item.errorAt = errorAt.get(place);
                places[place] = item;
            }
            return { provider: 'open-meteo-daylight', cacheMaxAgeMs, places, ...(fetchedAt ? { fetchedAt } : {}) };
        },
    };
}
