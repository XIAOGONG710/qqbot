// 真实天气（ADR 0048，ADR 0021 的 W5）：定时从 Open-Meteo 取她学校所在地（在学校）、家（放假在家）逐小时的气温、降水、天况，存在数据目录。
// 取哪里写在卡上（world.yml 的 weather.places，只给看得到她在哪座城市的档位）：源码里不写具体地点。
// 世界（world.ts）某一天有真实数据就用真实的，没有的（断网、模拟器、测试、开始取之前的日子）照旧按日期生成。
// - 「下没下雨」只算到这一刻为止真实下过的钟头，不把预报里晚上的雨提前当成「下雨了」；预报只写成「预报几点后有雨」。
// - 取的时候已经到了的钟头记成实况，存下就不再改；预报的永远不算「下过」：过去的事实不被后来取到的数据改写。
// - 开始用的那天（第一次取到时还没过凌晨 5 点就是当天，否则第二天）之前的日子不换；断网整天没数据的过去日子事后也不补。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { calendarDate, stateObject, stateTimestamp } from '../memory/state-schema.ts';
import { localDate } from '../local-date.ts';

/** 取天气的一个地方（卡上的 weather.places.school / home）：id 是缓存文件名（<id>.json），改了就从头取 */
export interface WeatherPlace { id: string; name: string; latitude: number; longitude: number }
/** 地方的 id */
export type Place = string;

/** 一个钟头：气温（℃）、降水（mm，前一小时累计）、天况（WMO 代码）；o：取的时候这个钟头已经到了（实况） */
export interface HourWeather { t: number; p: number; c: number; o?: 1 }

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
    /** 预报第一个下雨的钟头（later 那个）；主动消息排时刻用（ADR 0050） */
    laterHour?: number;
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

/** 降水到这么多（mm/小时）算下雨 */
const RAIN_MM = 0.2;
/** 一天至少有这么多个钟头的数据才按真实的 */
const MIN_HOURS = 12;
const MAX_WEATHER_HOURS = 24 * 14;
const MAX_WEATHER_RESPONSE_BYTES = 2 * 1024 * 1024;

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

const rainCode = (code: number) => code >= 51 && code <= 99;
const pad = (n: number) => String(n).padStart(2, '0');
/** 本地时间的 'YYYY-MM-DDTHH' */
const hourKey = (time: Date) => `${String(time.getFullYear()).padStart(4, '0')}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}T${pad(time.getHours())}`;
const dateOf = (time: Date) => hourKey(time).slice(0, 10);
const dayAfter = (date: string): string | undefined => {
    const next = localDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1);
    return next.getFullYear() >= 0 && next.getFullYear() <= 9999 ? dateOf(next) : undefined;
};

/**
 * 第 slot 个钟头（slot 点到 slot+1 点）下没下雨。Open-Meteo 逐小时的降水是「前一小时累计」，所以看 slot+1 那个 key 的降水；天况看 slot 那个 key。
 * observed：只看实况（o），预报的不算「下过」
 */
function wetSlot(hours: Readonly<Record<string, HourWeather>>, date: string, slot: number, observed: boolean, untilKey?: string): boolean {
    const precipKey = slot === 23 ? `${dayAfter(date)}T00` : `${date}T${pad(slot + 1)}`;
    const codeKey = `${date}T${pad(slot)}`;
    const precip = slot === 23 && !dayAfter(date) ? undefined : hours[precipKey];
    const code = hours[codeKey];
    // 累计降水在下一整点才成为观测；回放 14:00 时不能读取 15:00 的累计值。
    const available = (key: string, item: HourWeather | undefined) => item && (!observed || (item.o && (!untilKey || key <= untilKey)));
    return Boolean((available(precipKey, precip) && precip!.p >= RAIN_MM) || (available(codeKey, code) && rainCode(code!.c)));
}

/**
 * 存下来的钟头 → 那天到 until 为止的天气（纯函数，测试直接用）。
 * 下过雨的钟头只算实况、而且不晚于 until：预报的雨哪怕 until 在后面也不算下过（生活执行器会拿未来的时刻来看）
 */
export function dayFrom(hours: Readonly<Record<string, HourWeather>>, date: string, until: Date): DayWeather | undefined {
    const day = Array.from({ length: 24 }, (_, h) => hours[`${date}T${pad(h)}`]);
    const known = day.filter((hour): hour is HourWeather => Boolean(hour));
    if (known.length < MIN_HOURS) return undefined;
    const temps = known.map(hour => hour.t);
    const untilDate = dateOf(until);
    const nowHour = untilDate === date ? until.getHours() : date < untilDate ? 23 : -1;
    const rainHours = Array.from({ length: nowHour + 1 }, (_, slot) => slot).filter(slot => wetSlot(hours, date, slot, true, hourKey(until)));
    // 「现在」取 until 那个钟头；她的一天过了零点还算这一天（凌晨 5 点前），那时的「现在」在第二天的数据里
    const sameDay = untilDate === date || (untilDate === dayAfter(date) && until.getHours() < 5);
    const current = sameDay ? hours[hourKey(until)] : undefined;
    let ahead = -1;
    if (untilDate === date && rainHours.length === 0) {
        for (let slot = nowHour + 1; slot <= 22 && ahead < 0; slot++) if (wetSlot(hours, date, slot, false)) ahead = slot;
    }
    return {
        rain: rainHours.length > 0,
        low: Math.round(Math.min(...temps)),
        high: Math.round(Math.max(...temps)),
        real: true,
        ...(current ? { now: { text: weatherText(current.c), temp: Math.round(current.t) } } : {}),
        rainHours,
        ...(ahead >= 0 ? { later: `预报 ${ahead} 点后有雨`, laterHour: ahead } : {}),
    };
}

/**
 * 把新取到的钟头并进存着的（ADR 0048 审查后）：
 * - 取的时候已经到了的钟头记成实况（o）；存过的实况不再改，预报的可以被后来的覆盖；
 * - 过去的日子（今天之前）如果存着的不到半天，说明那天断网、按生成的天气过了，不补（补了就是改写过去）；
 * - 不删：世界每次从卡上的起始日重放到现在，删了的日子会退回生成的天气，把之后的猫粮、钱连锁改掉
 */
export function mergeHours(stored: Readonly<Record<string, HourWeather>>, fetched: Readonly<Record<string, HourWeather>>, fetchedAt: Date): Record<string, HourWeather> {
    const nowKey = hourKey(fetchedAt);
    const today = dateOf(fetchedAt);
    const merged: Record<string, HourWeather> = { ...stored };
    const storedPerDay = new Map<string, number>();
    for (const key of Object.keys(stored)) storedPerDay.set(key.slice(0, 10), (storedPerDay.get(key.slice(0, 10)) ?? 0) + 1);
    for (const [key, hour] of Object.entries(fetched)) {
        if (merged[key]?.o) continue;
        const date = key.slice(0, 10);
        if (date < today && (storedPerDay.get(date) ?? 0) < MIN_HOURS) continue;
        merged[key] = key <= nowKey ? { t: hour.t, p: hour.p, c: hour.c, o: 1 } : { t: hour.t, p: hour.p, c: hour.c };
    }
    return merged;
}

/** 第一次取到数据时从哪天开始用真实的：凌晨 5 点前取到就是今天（她还没起床），之后取到就从明天起，免得今天一半生成一半真实 */
export function firstRealDay(fetchedAt: Date): string {
    const first = fetchedAt.getHours() < 5 ? dateOf(fetchedAt) : dayAfter(dateOf(fetchedAt));
    if (!first || !calendarDate(first)) throw new RangeError('天气日期超出支持范围');
    return first;
}

/** 缓存同时使用本地日历键和 UTC 瞬时；两者都必须处于四位年范围。 */
function weatherTimestamp(at: Date): string | undefined {
    if (!Number.isFinite(at.getTime()) || at.getFullYear() < 0 || at.getFullYear() > 9999) return undefined;
    const timestamp = at.toISOString();
    return stateTimestamp(timestamp) ? timestamp : undefined;
}

/** Open-Meteo 的回复 → 钟头（它按 timezone=Asia/Shanghai 给本地时间 'YYYY-MM-DDTHH:00'） */
export function parseOpenMeteo(data: unknown): Record<string, HourWeather> {
    const hourly = (data as { hourly?: Record<string, unknown> } | null)?.hourly;
    const times = hourly?.time;
    const t = hourly?.temperature_2m;
    const p = hourly?.precipitation;
    const c = hourly?.weather_code;
    if (!Array.isArray(times) || !Array.isArray(t) || !Array.isArray(p) || !Array.isArray(c)
        || times.length !== t.length || times.length !== p.length || times.length !== c.length
        || times.length > MAX_WEATHER_HOURS) throw new Error('回复里没有合法的逐小时数据');
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
    /** 取哪几个地方（卡上的 weather.places）；id 要互不相同、能当文件名 */
    places: readonly WeatherPlace[];
    log: (message: string) => void;
    now?: () => number;
    /** 默认用全局 fetch；测试传假的 */
    fetchJson?: (url: string) => Promise<unknown>;
    /** 网络请求超时（毫秒）；默认 20 秒，避免天气服务卡住回复和生活执行器。 */
    timeoutMs?: number;
    /** 缓存超过这个时间只标记为 stale，仍可作为世界的降级数据；默认 2 小时。 */
    cacheMaxAgeMs?: number;
    /** 可替换的公开天气供应商；未提供时使用 Open-Meteo。 */
    provider?: WeatherProvider;
}

export interface WeatherProviderRequest {
    place: Place;
    latitude: number;
    longitude: number;
    signal: AbortSignal;
}

/** 天气供应商只返回逐小时数值，不接触 QQ、聊天或角色资料。 */
export interface WeatherProvider {
    readonly id: string;
    fetchHourly(request: WeatherProviderRequest): Promise<Record<string, HourWeather>>;
}

export interface WeatherPlaceStatus {
    fetchedAt?: string;
    ageMs?: number;
    stale?: boolean;
    hours: number;
    since?: string;
    error?: string;
    /** 最近一次取数失败的时间；用于区分“旧缓存”和“刚刚失败”。 */
    errorAt?: string;
}

export interface WeatherFetcherStatus {
    provider: string;
    cacheMaxAgeMs: number;
    places: Record<Place, WeatherPlaceStatus>;
    fetchedAt?: string;
}

function validHourly(hours: unknown): Record<string, HourWeather> {
    if (!hours || typeof hours !== 'object' || Array.isArray(hours)) throw new Error('供应商返回的天气不是对象');
    const output: Record<string, HourWeather> = {};
    const entries = Object.entries(hours);
    if (entries.length > MAX_WEATHER_HOURS) throw new Error('供应商返回的天气时数过多');
    for (const [key, value] of entries) {
        if (!validHourKey(key)) continue;
        const item = value as Partial<HourWeather> | null;
        if (!item || typeof item !== 'object' || !Number.isFinite(item.t) || !Number.isFinite(item.p) || !Number.isInteger(item.c)) continue;
        if (item.t! < -100 || item.t! > 100 || item.p! < 0 || item.p! > 1000 || item.c! < 0 || item.c! > 99) continue;
        output[key] = { t: item.t!, p: item.p!, c: item.c! };
    }
    if (!Object.keys(output).length) throw new Error('供应商没有返回有效天气小时');
    return output;
}

function validHourKey(key: string): boolean {
    return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(key) && calendarDate(key.slice(0, 10));
}

interface LegacyStore extends Omit<Store, 'fetchedAt'> { fetchedAt?: string }
function validStore(value: unknown): value is LegacyStore {
    if (!stateObject(value) || typeof value.since !== 'string' || !calendarDate(value.since)
        || !(value.fetchedAt === undefined || value.fetchedAt === '' || stateTimestamp(value.fetchedAt)) || !stateObject(value.hours)) return false;
    // 历史缓存不受供应商单次响应 14 天的限制；旧观察不能因轮转而丢失。
    return Object.entries(value.hours).every(([key, hour]) => validHourKey(key) && stateObject(hour)
        && typeof hour.t === 'number' && Number.isFinite(hour.t) && hour.t >= -100 && hour.t <= 100
        && typeof hour.p === 'number' && Number.isFinite(hour.p) && hour.p >= 0 && hour.p <= 1000
        && typeof hour.c === 'number' && Number.isInteger(hour.c) && hour.c >= 0 && hour.c <= 99
        && (hour.o === undefined || hour.o === 1));
}

/** AbortSignal 是协作取消；另设竞速保证不合作的注入供应商也不会永久锁住 inFlight。 */
async function withWeatherDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(parent?.reason ?? new Error('天气请求已取消'));
    if (parent?.aborted) cancel();
    else parent?.addEventListener('abort', cancel, { once: true });
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('天气请求超时')), timeoutMs);
    try {
        controller.signal.throwIfAborted();
        return await Promise.race([Promise.resolve().then(() => work(controller.signal)), aborted]);
    } finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', cancel);
        controller.signal.removeEventListener('abort', onAbort);
    }
}

/** 默认供应商：固定地点请求 Open-Meteo，响应先限大小再解析和校验。 */
export function openMeteoProvider(options: { fetchJson?: (url: string) => Promise<unknown>; timeoutMs?: number } = {}): WeatherProvider {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const fetchJson: (url: string, signal: AbortSignal) => Promise<unknown> = options.fetchJson ?? (async (url, signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_WEATHER_RESPONSE_BYTES) throw new Error('天气服务响应过大');
        return JSON.parse(text) as unknown;
    });
    return {
        id: 'open-meteo',
        async fetchHourly({ latitude, longitude, signal }: WeatherProviderRequest) {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
                + '&hourly=temperature_2m,precipitation,weather_code&past_days=2&forecast_days=2&timezone=Asia%2FShanghai';
            return withWeatherDeadline(async requestSignal => parseOpenMeteo(await fetchJson(url, requestSignal)), timeoutMs, signal);
        },
    };
}

export interface WeatherFetcher extends RealWeather {
    /** 取一次每个地方；失败只记日志，留着旧的 */
    refresh(): Promise<void>;
    /** 只返回数据新鲜度和覆盖范围，不返回坐标之外的个人信息。 */
    status(): WeatherFetcherStatus;
}

export function weatherFetcher(options: WeatherFetcherOptions): WeatherFetcher {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 2 * 60 * 60_000;
    const provider = options.provider ?? openMeteoProvider({ fetchJson: options.fetchJson, timeoutMs });
    // 数据目录第一次用时还没有（审查第 1 条：没建目录时每次写盘都失败，真实天气一次都不生效）
    mkdirSync(options.dir, { recursive: true });
    const byId = new Map(options.places.map(place => [place.id, place] as const));
    if (byId.size !== options.places.length || options.places.some(place => !/^[a-z][a-z0-9_-]*$/.test(place.id))) throw new Error('真实天气的地点 id 要互不相同，且是小写字母开头的字母、数字、- 或 _');
    const nameOf = (place: Place) => byId.get(place)?.name ?? place;
    const path = (place: Place) => join(options.dir, `${place}.json`);
    const stores = new Map<Place, Store | undefined>();
    const errors = new Map<Place, string>();
    const errorAt = new Map<Place, string>();
    let inFlight: Promise<void> | undefined;
    const load = (place: Place): Store | undefined => {
        if (!stores.has(place)) {
            try {
                const data = readJsonOr<LegacyStore | undefined>(path(place), undefined, undefined, { validate: validStore, invalid: 'throw', label: '天气缓存' });
                stores.set(place, data ? { ...data, fetchedAt: data.fetchedAt ?? '' } : undefined);
            } catch {
                // 不隔离、不重建，也不把 JSON 错误中的原文放进日志；修好后仍可再次读取。
                throw new Error(`${nameOf(place)}天气缓存读取或校验失败，保留原文件`);
            }
        }
        return stores.get(place);
    };
    const failed = (place: Place, error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        if (errors.get(place) !== reason) options.log(`真实天气：${nameOf(place)}没取到，照旧用存着的（${reason}）`);
        errors.set(place, reason);
        const timestamp = weatherTimestamp(new Date(now()));
        if (timestamp) errorAt.set(place, timestamp);
        else errorAt.delete(place);
    };
    return {
        day: (place, date, until) => {
            if (!byId.has(place)) return undefined;
            try {
                const store = load(place);
                return store && date >= store.since ? dayFrom(store.hours, date, until) : undefined;
            } catch (error) { failed(place, error); return undefined; }
        },
        refresh: () => {
            // 心跳和启动可能同时触发刷新；复用同一请求，避免重复打公开接口。
            if (inFlight) return inFlight;
            inFlight = (async () => {
                for (const place of options.places.map(place => place.id)) {
                    try {
                        const { latitude, longitude } = byId.get(place)!;
                        const fetched = validHourly(await withWeatherDeadline(signal => provider.fetchHourly({ place, latitude, longitude, signal }), timeoutMs));
                        const at = new Date(now());
                        const fetchedAt = weatherTimestamp(at);
                        if (!fetchedAt) throw new RangeError('天气刷新时钟超出支持范围');
                        const old = load(place);
                        const store: Store = { since: old?.since ?? firstRealDay(at), fetchedAt, hours: mergeHours(old?.hours ?? {}, fetched, at) };
                        writeJsonAtomic(path(place), store);
                        stores.set(place, store);
                        errors.delete(place);
                        errorAt.delete(place);
                    } catch (error) {
                        failed(place, error);
                    }
                }
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
        status: () => {
            const places = {} as Record<Place, WeatherPlaceStatus>;
            let fetchedAt: string | undefined;
            for (const place of options.places.map(place => place.id)) {
                let store: Store | undefined;
                try { store = load(place); } catch (error) { failed(place, error); }
                const item: WeatherPlaceStatus = { hours: Object.keys(store?.hours ?? {}).length };
                if (store?.fetchedAt) {
                    item.fetchedAt = store.fetchedAt;
                    const parsed = Date.parse(store.fetchedAt);
                    const age = now() - parsed;
                    if (Number.isFinite(age)) {
                        item.ageMs = Math.max(0, age);
                        item.stale = item.ageMs > cacheMaxAgeMs;
                    }
                    fetchedAt = !fetchedAt || store.fetchedAt > fetchedAt ? store.fetchedAt : fetchedAt;
                }
                if (store?.since) item.since = store.since;
                const error = errors.get(place);
                if (error) item.error = error;
                const failedAt = errorAt.get(place);
                if (failedAt) item.errorAt = failedAt;
                places[place] = item;
            }
            return { provider: provider.id, cacheMaxAgeMs, places, ...(fetchedAt ? { fetchedAt } : {}) };
        },
    };
}
