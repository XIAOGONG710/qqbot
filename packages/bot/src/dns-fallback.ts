// 模型接口的 DNS 兜底（ADR 0070 第 17 项）：虚拟机的系统解析器会连续几个小时解析不了 api.deepseek.com
// （10-13 21:46 起到 10-14 15:49，累计 14.7 小时，期间她一句话都回不了），而这台机器当时到公网的直连是通的概率很大。
// 做法：解析成功就记下地址（内存 + 一个小文件，重启后也在）；解析失败（ENOTFOUND / EAI_AGAIN / 超时）并且这个域名在白名单里，
// 就用上次解析到的地址去连。TLS 照常按域名校验证书（只替换连接地址，不改主机名），所以不会连到别人那里去。
// 只给模型接口用；图片下载有自己的 SSRF 校验（safe-image.ts），不走这里。

import { lookup as systemLookup, type LookupOptions } from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import type { LookupFunction } from 'node:net';

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
    const memory: Cache = {};
    let warnedAt = 0;

    const load = (): Cache => {
        if (!options.file) return memory;
        try { return { ...JSON.parse(readFileSync(options.file, 'utf8')) as Cache, ...memory }; } catch { return memory; }
    };
    const remember = (host: string, addresses: CachedAddress[]) => {
        if (!addresses.length) return;
        const previous = memory[host]?.addresses.map(item => item.address).join();
        memory[host] = { at: now(), addresses };
        // 地址没变就不重复写文件
        if (!options.file || previous === addresses.map(item => item.address).join()) return;
        try { writeFileSync(options.file, JSON.stringify(load())); } catch { /* 写不了就只放内存 */ }
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
            if (!FALLBACK_CODES.has(String(error.code)) || !cached || now() - cached.at > maxAge) {
                (callback as (error: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void)(error);
                return;
            }
            if (now() - warnedAt > 3_600_000) {
                warnedAt = now();
                options.log?.(`DNS 解析 ${hostname} 失败（${String(error.code)}），改用 ${Math.round((now() - cached.at) / 60_000)} 分钟前解析到的地址 ${cached.addresses[0]!.address}`);
            }
            const addresses = cached.addresses;
            if (wantAll) (callback as (error: null, address: CachedAddress[]) => void)(null, addresses);
            else (callback as (error: null, address: string, family: number) => void)(null, addresses[0]!.address, addresses[0]!.family);
        });
    };
}
