// 模型接口的 DNS 兜底（ADR 0070 第 17 项）：虚拟机的系统解析器会连续几个小时解析不了 api.deepseek.com
// （10-13 21:46 起到 10-14 15:49，累计 14.7 小时，期间她一句话都回不了），而这台机器当时到公网的直连是通的概率很大。
// 做法：解析成功就记下地址（内存 + 一个小文件，重启后也在）；解析失败（ENOTFOUND / EAI_AGAIN / 超时）并且这个域名在白名单里，
// 就用上次解析到的地址去连。TLS 照常按域名校验证书（只替换连接地址，不改主机名），所以不会连到别人那里去。
// 只给模型接口用；图片下载有自己的 SSRF 校验（safe-image.ts），不走这里。

import { lookup as systemLookup, type LookupOptions } from 'node:dns';
import { readFileSync } from 'node:fs';
import { isIP, type LookupFunction } from 'node:net';
import { writeJsonAtomic } from '.././memory/json-file.ts';
import { stateObject } from '.././memory/state-schema.ts';

export interface CachedAddress { address: string; family: number }
type Cache = Record<string, { at: number; addresses: CachedAddress[] }>;

export interface DnsFallbackOptions {
    /** 只给这些域名兜底 */
    hosts: readonly string[];
    /** 缓存文件；不给就只放内存 */
    file?: string;
    /** 缓存超过这么久不用（毫秒）；默认 7 天 */
    maxAgeMs?: number;
    lookup?: (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | CachedAddress[], family?: number) => void) => void;
    now?: () => number;
    log?: (message: string) => void;
}

const FALLBACK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT', 'ESERVFAIL', 'ECONNREFUSED']);

export function fallbackLookup(options: DnsFallbackOptions): LookupFunction {
    const lookup = options.lookup ?? (systemLookup as unknown as NonNullable<DnsFallbackOptions['lookup']>);
    const now = options.now ?? Date.now;
    const maxAge = options.maxAgeMs ?? 7 * 24 * 3_600_000;
    const memory: Cache = Object.create(null);
    const persistedAt = new Map<string, number>();
    let warnedAt = -Infinity;

    const validAddress = (value: unknown): value is CachedAddress => stateObject(value)
        && typeof value.address === 'string' && (value.family === 4 || value.family === 6)
        && isIP(value.address) === value.family;

    const load = (): Cache => {
        if (!options.file) return memory;
        try {
            const parsed: unknown = JSON.parse(readFileSync(options.file, 'utf8'));
            const disk: Cache = Object.create(null);
            if (stateObject(parsed)) for (const host of options.hosts) {
                const entry = Object.hasOwn(parsed, host) ? parsed[host] : undefined;
                if (stateObject(entry) && typeof entry.at === 'number' && Number.isFinite(entry.at)
                    && entry.at >= 0 && entry.at <= now() && Array.isArray(entry.addresses)
                    && entry.addresses.length > 0 && entry.addresses.every(validAddress)) disk[host] = entry as Cache[string];
            }
            return { ...disk, ...memory };
        } catch { return memory; }
    };
    const remember = (host: string, addresses: CachedAddress[]) => {
        if (!addresses.length || !addresses.every(validAddress)) return;
        const previous = JSON.stringify(memory[host]?.addresses);
        memory[host] = { at: now(), addresses };
        // 地址不变也定期刷新落盘时间，否则长期健康后重启反而读到过期缓存。
        if (!options.file || (previous === JSON.stringify(addresses)
            && now() - (persistedAt.get(host) ?? -Infinity) < Math.min(3_600_000, maxAge / 2))) return;
        try { writeJsonAtomic(options.file, load()); persistedAt.set(host, now()); } catch { /* 写不了就只放内存 */ }
    };

    return (hostname, lookupOptions, callback) => {
        const wantAll = Boolean((lookupOptions as { all?: boolean }).all);
        lookup(hostname, lookupOptions as LookupOptions, (error, address, family) => {
            if (!error) {
                if (options.hosts.includes(hostname)) {
                    remember(hostname, Array.isArray(address) ? address : [{ address: String(address), family: Number(family ?? 4) }]);
                }
                (callback as (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => void)(null, address, family);
                return;
            }
            const cached = options.hosts.includes(hostname) ? load()[hostname] : undefined;
            const requestedFamily = (lookupOptions as LookupOptions).family;
            const addresses = cached?.addresses.filter(item => !requestedFamily || item.family === requestedFamily) ?? [];
            if (!FALLBACK_CODES.has(String(error.code)) || !cached || now() - cached.at < 0
                || now() - cached.at > maxAge || !addresses.length) {
                (callback as (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void)(error);
                return;
            }
            if (now() - warnedAt > 3_600_000) {
                warnedAt = now();
                options.log?.(`DNS 解析 ${hostname} 失败（${String(error.code)}），改用 ${Math.round((now() - cached.at) / 60_000)} 分钟前解析到的地址 ${addresses[0]!.address}`);
            }
            if (wantAll) (callback as (error: null, address: CachedAddress[]) => void)(null, addresses);
            else (callback as (error: null, address: string, family: number) => void)(null, addresses[0]!.address, addresses[0]!.family);
        });
    };
}
