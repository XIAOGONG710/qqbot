// 现实交通 / 公共服务事实适配器（ADR 0232）。
// 这是一个通用、安全的 provider 外壳：调用方显式提供地点、端点和解析格式，模块本身不绑定私有接口或账号。
// 数据只作为环境事实缓存；过期、失败或没有当前观测时，调用方应当忽略它。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { cacheAgeMs } from './cache-freshness.ts';

export type TransportState = 'normal' | 'delayed' | 'closed' | 'unknown';

export interface TransportFact {
    location: string;
    status: TransportState;
    observedAt: string;
    source: string;
    real: true;
    detail?: string;
}

export interface RealTransport {
    day(location: string, until?: Date): TransportFact | undefined;
}

let current: RealTransport | undefined;
/** 线上由宿主显式接入；没有供应商时世界不写交通事实。 */
export function useRealTransport(source: RealTransport | undefined): void { current = source; }
export function realTransport(): RealTransport | undefined { return current; }

export interface TransportLocation { id: string; name?: string }
export interface TransportStore { fetchedAt: string; facts: Record<string, TransportFact> }

const MAX_LOCATIONS = 50;
const MAX_DETAIL = 160;
const MAX_ERROR = 160;
const MAX_RESPONSE_BYTES = 512 * 1024;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stateOf(value: unknown): TransportState | undefined {
    if (value === 'normal' || value === 'delayed' || value === 'closed' || value === 'unknown') return value;
    if (value === '正常') return 'normal';
    if (value === '延误' || value === '晚点') return 'delayed';
    if (value === '关闭' || value === '停运') return 'closed';
    if (value === '未知') return 'unknown';
    return undefined;
}

/** 供应商异常只保留短诊断摘要；日志和状态都不能带出 URL 凭据、令牌或 Cookie。 */
export function sanitizeTransportError(reason: unknown): string {
    const raw = reason instanceof Error ? reason.message : String(reason);
    const safe = raw
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
        .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,，;；]+/gi, '$1=<redacted>')
        .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1=<redacted>')
        .replace(/\b(session(?:id)?|refresh[_-]?token)\s*[:=]\s*[^\s,，;；]+/gi, '$1=<redacted>')
        .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?<redacted>')
        .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|密码)\s*[:：=]\s*[^\s,，;；&#]+/gi, '$1=<redacted>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_ERROR);
    return safe || '未知错误';
}

function validFact(value: unknown): value is TransportFact {
    const status = isRecord(value) ? value.status : undefined;
    if (!isRecord(value) || typeof value.location !== 'string' || !value.location.trim() || !stateOf(status)
        || status !== 'normal' && status !== 'delayed' && status !== 'closed' && status !== 'unknown'
        || value.real !== true || typeof value.source !== 'string' || !value.source.trim()
        || typeof value.observedAt !== 'string' || !DATE_TIME.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) return false;
    return value.detail === undefined || (typeof value.detail === 'string' && value.detail.length <= MAX_DETAIL);
}

export function isTransportStore(value: unknown): value is TransportStore {
    if (!isRecord(value) || typeof value.fetchedAt !== 'string' || !DATE_TIME.test(value.fetchedAt)
        || !Number.isFinite(Date.parse(value.fetchedAt)) || !isRecord(value.facts)) return false;
    const facts = Object.entries(value.facts);
    return facts.length > 0 && facts.every(([key, fact]) => Boolean(key.trim()) && key.length <= 80 && validFact(fact));
}

export function readTransportStore(path: string, log?: (message: string) => void, invalid: 'quarantine' | 'throw' = 'quarantine'): TransportStore | undefined {
    return readJsonOr<TransportStore | undefined>(path, undefined, log, {
        validate: (value): value is TransportStore | undefined => isTransportStore(value),
        invalid,
        label: '交通缓存',
    });
}

/**
 * 解析通用公共交通响应：顶层可用数组、items 或 data；每一项至少有 status 和 updatedAt。
 * location 缺省时使用请求地点，避免供应商把一条结果误投到别的地点。
 */
export function parseTransportResponse(data: unknown, requestedLocation: string, source: string): TransportFact[] {
    const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.items) ? data.items : isRecord(data) && Array.isArray(data.data) ? data.data : undefined;
    if (!rows || rows.length > MAX_LOCATIONS) throw new Error('回复里没有合法的交通 / 公共服务条目');
    const output: TransportFact[] = [];
    for (const raw of rows) {
        if (!isRecord(raw)) continue;
        const location = typeof raw.location === 'string' && raw.location.trim() ? raw.location.trim().slice(0, 80) : requestedLocation;
        const status = stateOf(raw.status);
        const observedAt = typeof raw.updatedAt === 'string' && DATE_TIME.test(raw.updatedAt) && Number.isFinite(Date.parse(raw.updatedAt)) ? new Date(raw.updatedAt).toISOString() : undefined;
        if (!status || !observedAt) continue;
        const detail = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, MAX_DETAIL) : undefined;
        output.push({ location, status, observedAt, source, real: true, ...(detail ? { detail } : {}) });
    }
    if (!output.length) throw new Error('供应商没有返回有效的交通 / 公共服务事实');
    return output;
}

export interface TransportFetcherOptions {
    dir: string;
    log: (message: string) => void;
    locations: readonly TransportLocation[];
    endpoint: string | ((location: TransportLocation) => string);
    source: string;
    now?: () => number;
    fetchJson?: (url: string) => Promise<unknown>;
    request?: (url: string, init: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    cacheMaxAgeMs?: number;
}

export interface TransportLocationStatus { status?: TransportState; observedAt?: string; detail?: string; ageMs?: number; stale?: boolean; error?: string; errorAt?: string }
export interface TransportFetcherStatus { provider: string; source: string; cacheMaxAgeMs: number; locations: Record<string, TransportLocationStatus>; fetchedAt?: string; stale?: boolean }
export interface TransportFetcher extends RealTransport { refresh(): Promise<void>; status(): TransportFetcherStatus }

export function transportFetcher(options: TransportFetcherOptions): TransportFetcher {
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 30 * 60_000;
    const locations = [...options.locations].slice(0, MAX_LOCATIONS);
    const request = options.request ?? fetch;
    const fetchJson = options.fetchJson ?? (async (url: string) => {
        // 配置校验只覆盖起始端点；禁止自动跟随重定向，避免供应商把请求转去
        // 本机、私网或另一个未经确认的来源。
        const response = await request(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('交通 / 公共服务响应过大');
        return JSON.parse(text) as unknown;
    });
    mkdirSync(options.dir, { recursive: true });
    const cachePath = join(options.dir, 'transport.json');
    let store: TransportStore | undefined;
    let loaded = false;
    const errors = new Map<string, string>();
    const errorAt = new Map<string, string>();
    let inFlight: Promise<void> | undefined;
    const load = (): TransportStore | undefined => {
        if (loaded) return store;
        loaded = true;
        const data = readTransportStore(cachePath, message => options.log(`现实交通：${message}`));
        if (!data) return undefined;
        const facts = Object.fromEntries(Object.entries(data.facts).filter(([, fact]) => fact.source === options.source));
        store = Object.keys(facts).length ? { fetchedAt: data.fetchedAt, facts } : undefined;
        return store;
    };
    return {
        day: (location, until) => {
            const cached = load();
            if (!cached) return undefined;
            const current = now();
            const fetchedAge = cacheAgeMs(cached.fetchedAt, current);
            if (fetchedAge === undefined || fetchedAge > cacheMaxAgeMs) return undefined;
            const fact = cached.facts[location];
            const observedAt = fact ? Date.parse(fact.observedAt) : NaN;
            const observedAge = fact ? cacheAgeMs(fact.observedAt, current) : undefined;
            if (!fact || observedAge === undefined || observedAge > cacheMaxAgeMs || (until && observedAt > until.getTime())) return undefined;
            return fact;
        },
        refresh: () => {
            if (inFlight) return inFlight;
            inFlight = (async () => {
                const merged = { ...(load()?.facts ?? {}) };
                let success = false;
                const accept = (location: TransportLocation, facts: readonly TransportFact[]): void => {
                    const matched = facts.filter(fact => fact.location === location.id || (location.name !== undefined && fact.location === location.name));
                    const fact = matched.length === 1 ? matched[0] : undefined;
                    if (!fact) throw new Error(matched.length > 1 ? '供应商返回了多条相同地点的交通事实' : '供应商响应里没有当前地点的交通事实');
                    merged[location.id] = fact;
                    success = true;
                    errors.delete(location.id); errorAt.delete(location.id);
                };
                if (typeof options.endpoint === 'string') {
                    try {
                        // 共享端点一轮只请求一次。配置了多个地点时，单条无地点响应不能被
                        // 猜成每个地点的事实，必须由供应商返回稳定 id 或配置中的显示名。
                        const fallback = locations.length === 1 ? locations[0]!.id : '';
                        const facts = parseTransportResponse(await fetchJson(options.endpoint), fallback, options.source);
                        for (const location of locations) {
                            try { accept(location, facts); }
                            catch (reason) {
                                const message = sanitizeTransportError(reason);
                                errors.set(location.id, message); errorAt.set(location.id, new Date(now()).toISOString());
                                options.log(`现实交通：${location.name ?? location.id}没取到，照旧不用它（${message}）`);
                            }
                        }
                    } catch (reason) {
                        const message = sanitizeTransportError(reason);
                        for (const location of locations) {
                            errors.set(location.id, message); errorAt.set(location.id, new Date(now()).toISOString());
                            options.log(`现实交通：${location.name ?? location.id}没取到，照旧不用它（${message}）`);
                        }
                    }
                } else {
                    for (const location of locations) {
                        try {
                            const facts = parseTransportResponse(await fetchJson(options.endpoint(location)), location.id, options.source);
                            accept(location, facts);
                        } catch (reason) {
                            const message = sanitizeTransportError(reason);
                            errors.set(location.id, message); errorAt.set(location.id, new Date(now()).toISOString());
                            options.log(`现实交通：${location.name ?? location.id}没取到，照旧不用它（${message}）`);
                        }
                    }
                }
                if (success) {
                    store = { fetchedAt: new Date(now()).toISOString(), facts: merged };
                    loaded = true;
                    writeJsonAtomic(cachePath, store);
                }
            })().finally(() => { inFlight = undefined; });
            return inFlight;
        },
        status: () => {
            const cached = load();
            const fetchedAt = cached?.fetchedAt;
            const current = now();
            const fetchedAge = fetchedAt ? cacheAgeMs(fetchedAt, current) : undefined;
            const locationsStatus: Record<string, TransportLocationStatus> = {};
            for (const location of locations) {
                const fact = cached?.facts[location.id];
                const item: TransportLocationStatus = fact ? { status: fact.status, observedAt: fact.observedAt, ...(fact.detail ? { detail: fact.detail } : {}) } : {};
                if (fact) {
                    const age = cacheAgeMs(fact.observedAt, current);
                    if (age === undefined) item.stale = true;
                    else { item.ageMs = age; item.stale = age > cacheMaxAgeMs; }
                }
                if (errors.has(location.id)) item.error = errors.get(location.id);
                if (errorAt.has(location.id)) item.errorAt = errorAt.get(location.id);
                locationsStatus[location.id] = item;
            }
            return {
                provider: 'generic-transport', source: options.source, cacheMaxAgeMs, locations: locationsStatus,
                ...(fetchedAt ? { fetchedAt } : {}),
                ...(fetchedAt ? { stale: fetchedAge === undefined || fetchedAge > cacheMaxAgeMs } : {}),
            };
        },
    };
}
