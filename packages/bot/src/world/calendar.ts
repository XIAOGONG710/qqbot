// 现实法定日历（ADR 0231）：只读公开的节假日 / 调休工作日，补进世界事实。
// 它不直接改角色卡的课程表；学校自己的放假和补课仍由 schedule.holidays / makeups 负责。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export type PublicCalendarKind = 'holiday' | 'workday';
export interface PublicCalendarDay { date: string; name: string; kind: PublicCalendarKind; real: true }
export interface RealCalendar { day(date: string): PublicCalendarDay | undefined }

interface Store { fetchedAt: string; years: Record<string, Record<string, PublicCalendarDay>> }
let current: RealCalendar | undefined;

/** 线上（app.ts）开；模拟器、测试不开。 */
export function useRealCalendar(source: RealCalendar | undefined): void { current = source; }
export function realCalendar(): RealCalendar | undefined { return current; }

const MAX_DAYS = 366;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 兼容 holiday.ailcc.com 的 year 接口：holiday[MM-DD] 里 holiday=true/false，date/name 给出日期和名称。 */
export function parseHolidayApi(data: unknown, year: number): Record<string, PublicCalendarDay> {
    const rows = isRecord(data) && isRecord(data.holiday) ? data.holiday : undefined;
    if (!rows) throw new Error('回复里没有合法的法定日历');
    const output: Record<string, PublicCalendarDay> = {};
    for (const [key, raw] of Object.entries(rows)) {
        if (Object.keys(output).length >= MAX_DAYS) throw new Error('供应商返回的法定日历天数过多');
        if (!isRecord(raw)) continue;
        const date = typeof raw.date === 'string' && DATE_ONLY.test(raw.date) ? raw.date
            : /^\d{2}-\d{2}$/.test(key) ? `${year}-${key}` : undefined;
        const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
        if (!date || !date.startsWith(`${year}-`) || !name) continue;
        const flag = raw.holiday;
        const workday = flag === false || /班|补班|上班/.test(name);
        const holiday = flag === true || (!workday && /假|休|节/.test(name));
        if (!holiday && !workday) continue;
        output[date] = { date, name, kind: workday ? 'workday' : 'holiday', real: true };
    }
    if (!Object.keys(output).length) throw new Error('供应商没有返回有效的法定日历');
    return output;
}

export interface CalendarFetcherOptions {
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    fetchJson?: (url: string) => Promise<unknown>;
    timeoutMs?: number;
    cacheMaxAgeMs?: number;
    /** 默认当前年和下一年；测试或自建供应商可缩小请求范围。 */
    years?: (now: Date) => readonly number[];
}

export interface CalendarStatus { provider: string; cacheMaxAgeMs: number; years: number[]; fetchedAt?: string; ageMs?: number; stale?: boolean; error?: string; errorAt?: string }
export interface CalendarFetcher extends RealCalendar { refresh(): Promise<void>; status(): CalendarStatus }

export function calendarFetcher(options: CalendarFetcherOptions): CalendarFetcher {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 7 * 86_400_000;
    const yearsFor = options.years ?? ((at: Date) => [at.getFullYear(), at.getFullYear() + 1]);
    const fetchJson = options.fetchJson ?? (async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('法定日历服务响应过大');
        return JSON.parse(text) as unknown;
    });
    mkdirSync(options.dir, { recursive: true });
    const cachePath = join(options.dir, 'calendar.json');
    let store: Store | undefined;
    let error: string | undefined;
    let errorAt: string | undefined;
    let inFlight: Promise<void> | undefined;
    const load = (): Store | undefined => {
        if (store !== undefined) return store;
        const data = readJsonOr<Partial<Store>>(cachePath, {}, message => options.log(`现实法定日历：${message}`));
        store = data.fetchedAt && isRecord(data.years) ? { fetchedAt: data.fetchedAt, years: data.years as Store['years'] } : undefined;
        return store;
    };
    return {
        day: date => {
            if (!DATE_ONLY.test(date)) return undefined;
            const cached = load();
            if (!cached) return undefined;
            const fetchedAt = Date.parse(cached.fetchedAt);
            if (!Number.isFinite(fetchedAt) || now() - fetchedAt > cacheMaxAgeMs) return undefined;
            return cached.years[date.slice(0, 4)]?.[date];
        },
        refresh: () => {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                const at = new Date(now());
                const wanted = [...new Set(yearsFor(at).filter(year => Number.isInteger(year) && year >= 2000 && year <= 2200))];
                if (!wanted.length) return;
                const merged = { ...(load()?.years ?? {}) };
                let success = false;
                for (const year of wanted) {
                    try {
                        const url = `https://holiday.ailcc.com/api/holiday/year/${year}`;
                        merged[String(year)] = parseHolidayApi(await fetchJson(url), year);
                        success = true;
                        error = undefined; errorAt = undefined;
                    } catch (reason) {
                        error = reason instanceof Error ? reason.message : String(reason);
                        errorAt = new Date(now()).toISOString();
                        options.log(`现实法定日历：${year} 年没取到，照旧不用它（${error}）`);
                    }
                }
                if (success) {
                    store = { fetchedAt: new Date(now()).toISOString(), years: merged };
                    writeJsonAtomic(cachePath, store);
                }
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
        status: () => {
            const cached = load();
            const fetchedAt = cached?.fetchedAt;
            const parsed = fetchedAt ? Date.parse(fetchedAt) : NaN;
            const years = Object.keys(cached?.years ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
            return {
                provider: 'holiday.ailcc.com', cacheMaxAgeMs, years,
                ...(fetchedAt ? { fetchedAt } : {}),
                ...(Number.isFinite(parsed) ? { ageMs: Math.max(0, now() - parsed), stale: now() - parsed > cacheMaxAgeMs } : {}),
                ...(error ? { error } : {}), ...(errorAt ? { errorAt } : {}),
            };
        },
    };
}
