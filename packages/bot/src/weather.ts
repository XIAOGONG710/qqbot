// 真实天气（ADR 0048，ADR 0021 的 W5）：定时从 Open-Meteo 取济南（在学校）、青岛（放假在家）逐小时的气温、降水、天况，存在数据目录。
// 世界（world.ts）某一天有真实数据就用真实的，没有的（断网、模拟器、测试、开始取之前的日子）照旧按日期生成。
// - 「下没下雨」只算到这一刻为止真实下过的钟头，不把预报里晚上的雨提前当成「下雨了」；预报只写成「预报几点后有雨」。
// - 已经过去 FREEZE_HOURS 小时以上的钟头存下来就不再改：过去的事实不被后来取到的数据改写。
// - 开始取的那天之前的日子不换（日记、记忆里已经按生成的天气写过）。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export type Place = 'jinan' | 'qingdao';

export const PLACES: Record<Place, { name: string; latitude: number; longitude: number }> = {
    jinan: { name: '济南', latitude: 36.65, longitude: 117.12 },
    qingdao: { name: '青岛西海岸', latitude: 35.96, longitude: 120.19 },
};

/** 一个钟头：气温（℃）、降水（mm）、天况（WMO 代码） */
export interface HourWeather { t: number; p: number; c: number }

interface Store {
    /** 第一次取到的日子（她的一天，YYYY-MM-DD）：之前的日子不换 */
    since: string;
    fetchedAt: string;
    /** 'YYYY-MM-DDTHH' → 那个钟头 */
    hours: Record<string, HourWeather>;
}

/** 世界里一天的天气（world.ts 的 WorldNow.weather）；real 的才有后面几项 */
export interface DayWeather {
    rain: boolean;
    low: number;
    high: number;
    real?: true;
    /** 这一刻：天况、气温 */
    now?: { text: string; temp: number };
    /** 到这一刻为止下过雨（雪）的钟头（0–23） */
    rainHours?: number[];
    /** 还没下、预报之后有：「预报 20 点后有雨」 */
    later?: string;
}

/** 世界读真实天气的接口 */
export interface RealWeather {
    /** 那天（YYYY-MM-DD，日历日）到 until 为止的天气；没有数据、在开始取之前就是 undefined */
    day(place: Place, date: string, until: Date): DayWeather | undefined;
}

let current: RealWeather | undefined;
/** 线上（app.ts）开；模拟器、测试不开，世界按日期生成，结果可复现 */
export function useRealWeather(source: RealWeather | undefined): void {
    current = source;
}
export function realWeather(): RealWeather | undefined {
    return current;
}

/** 过去多少小时以上的钟头不再改 */
export const FREEZE_HOURS = 3;
/** 存多少天 */
const KEEP_DAYS = 40;
/** 降水到这么多（mm/小时）算下雨 */
const RAIN_MM = 0.2;

/** WMO 天况代码 → 说法 */
export function weatherText(code: number): string {
    if (code <= 1) return '晴';
    if (code === 2) return '多云';
    if (code === 3) return '阴';
    if (code === 45 || code === 48) return '有雾';
    if (code >= 51 && code <= 55) return '下毛毛雨';
    if (code === 56 || code === 57 || code === 66 || code === 67) return '下冻雨';
    if (code === 61) return '下小雨';
    if (code === 63) return '下中雨';
    if (code === 65) return '下大雨';
    if (code === 71 || code === 77 || code === 85) return '下小雪';
    if (code === 73) return '下中雪';
    if (code === 75 || code === 86) return '下大雪';
    if (code === 80 || code === 81) return '下阵雨';
    if (code === 82) return '下大阵雨';
    if (code >= 95) return '打雷下雨';
    return '阴';
}

const wet = (hour: HourWeather) => hour.p >= RAIN_MM || (hour.c >= 51 && hour.c <= 99 && hour.c !== 45 && hour.c !== 48);
const pad = (n: number) => String(n).padStart(2, '0');
/** 本地时间的 'YYYY-MM-DDTHH' */
const hourKey = (time: Date) => `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}`;
const dateOf = (time: Date) => hourKey(time).slice(0, 10);

/** 存下来的钟头 → 那天到 until 为止的天气（纯函数，测试直接用） */
export function dayFrom(hours: Readonly<Record<string, HourWeather>>, date: string, until: Date): DayWeather | undefined {
    const day = Array.from({ length: 24 }, (_, h) => hours[`${date}T${pad(h)}`]);
    const known = day.filter((hour): hour is HourWeather => Boolean(hour));
    if (known.length < 12) return undefined;
    const temps = known.map(hour => hour.t);
    const untilDate = dateOf(until);
    const nowHour = untilDate === date ? until.getHours() : date < untilDate ? 23 : -1;
    const rainHours = day.flatMap((hour, h) => (hour && h <= nowHour && wet(hour) ? [h] : []));
    // 「现在」取 until 那个钟头；她的一天过了零点还算这一天（凌晨 5 点前），那时的「现在」在第二天的数据里
    const next = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1);
    const sameDay = untilDate === date || (untilDate === dateOf(next) && until.getHours() < 5);
    const current = sameDay ? hours[hourKey(until)] : undefined;
    const ahead = untilDate === date && nowHour < 23 && rainHours.length === 0
        ? day.findIndex((hour, h) => h > nowHour && h <= 22 && hour !== undefined && wet(hour))
        : -1;
    return {
        rain: rainHours.length > 0,
        low: Math.round(Math.min(...temps)),
        high: Math.round(Math.max(...temps)),
        real: true,
        ...(current ? { now: { text: weatherText(current.c), temp: Math.round(current.t) } } : {}),
        rainHours,
        ...(ahead > 0 ? { later: `预报 ${ahead} 点后有雨` } : {}),
    };
}

/** 把新取到的钟头并进存着的：过去 FREEZE_HOURS 小时以上、已经存过的不改；太久的丢掉 */
export function mergeHours(stored: Readonly<Record<string, HourWeather>>, fetched: Readonly<Record<string, HourWeather>>, fetchedAt: Date): Record<string, HourWeather> {
    const freeze = hourKey(new Date(fetchedAt.getTime() - FREEZE_HOURS * 3_600_000));
    const oldest = dateOf(new Date(fetchedAt.getTime() - KEEP_DAYS * 86_400_000));
    const merged: Record<string, HourWeather> = {};
    for (const [key, hour] of Object.entries(stored)) if (key.slice(0, 10) >= oldest) merged[key] = hour;
    for (const [key, hour] of Object.entries(fetched)) {
        if (key.slice(0, 10) < oldest) continue;
        if (merged[key] && key <= freeze) continue;
        merged[key] = hour;
    }
    return merged;
}

/** Open-Meteo 的回复 → 钟头（它按 timezone=Asia/Shanghai 给本地时间 'YYYY-MM-DDTHH:00'） */
export function parseOpenMeteo(data: unknown): Record<string, HourWeather> {
    const hourly = (data as { hourly?: Record<string, unknown> } | null)?.hourly;
    const times = hourly?.time;
    const t = hourly?.temperature_2m;
    const p = hourly?.precipitation;
    const c = hourly?.weather_code;
    if (!Array.isArray(times) || !Array.isArray(t) || !Array.isArray(p) || !Array.isArray(c)) throw new Error('回复里没有逐小时数据');
    const hours: Record<string, HourWeather> = {};
    times.forEach((time, i) => {
        if (typeof time !== 'string' || typeof t[i] !== 'number' || typeof p[i] !== 'number' || typeof c[i] !== 'number') return;
        hours[time.slice(0, 13)] = { t: t[i] as number, p: p[i] as number, c: c[i] as number };
    });
    return hours;
}

export interface WeatherFetcherOptions {
    /** 存数据的目录（<数据目录>/weather） */
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    /** 默认用全局 fetch；测试传假的 */
    fetchJson?: (url: string) => Promise<unknown>;
}

export interface WeatherFetcher extends RealWeather {
    /** 取一次两个地方；失败只记日志，留着旧的 */
    refresh(): Promise<void>;
}

export function weatherFetcher(options: WeatherFetcherOptions): WeatherFetcher {
    const now = options.now ?? Date.now;
    const fetchJson = options.fetchJson ?? (async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    });
    const path = (place: Place) => join(options.dir, `${place}.json`);
    const stores = new Map<Place, Store | undefined>();
    const load = (place: Place): Store | undefined => {
        if (!stores.has(place)) {
            const data = readJsonOr<Partial<Store>>(path(place), {}, message => options.log(`真实天气：${message}`));
            stores.set(place, data.since && data.hours ? { since: data.since, fetchedAt: data.fetchedAt ?? '', hours: data.hours } : undefined);
        }
        return stores.get(place);
    };
    return {
        day: (place, date, until) => {
            const store = load(place);
            return store && date >= store.since ? dayFrom(store.hours, date, until) : undefined;
        },
        refresh: async () => {
            for (const place of Object.keys(PLACES) as Place[]) {
                const { latitude, longitude } = PLACES[place];
                const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
                    + '&hourly=temperature_2m,precipitation,weather_code&past_days=2&forecast_days=2&timezone=Asia%2FShanghai';
                try {
                    const fetched = parseOpenMeteo(await fetchJson(url));
                    const at = new Date(now());
                    const old = load(place);
                    const store: Store = { since: old?.since ?? dateOf(at), fetchedAt: at.toISOString(), hours: mergeHours(old?.hours ?? {}, fetched, at) };
                    writeJsonAtomic(path(place), store);
                    stores.set(place, store);
                } catch (error) {
                    options.log(`真实天气：${PLACES[place].name}没取到，照旧用存着的（${error instanceof Error ? error.message : String(error)}）`);
                }
            }
        },
    };
}
