// 平台账号的持久熔断器（ADR 0147）：碰到风控（HTTP 403 / 412 / 429，或平台自己的风控码）就整体停下，状态存盘，重启不丢；
// 只有人在本机运行命令行（`npm run platform -w @qqbot/bot -- resume <平台> --acknowledge-account-risk`）才能恢复，程序自己、模型都解不开。
// 想法来自 dsh-bili-humanism 的做法（10-25 读它的 README）：账号是用户实名担着的，被风控之后继续「过一阵再试」只会让账号更像机器人。
//
// 只管「要不要继续发请求」，不管请求怎么发、发给谁；各平台的适配器用 guardRequest 包一层自己的请求函数就行。

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '.././json-file.ts';

export interface BreakerState {
    platform: string;
    /** 毫秒 */
    trippedAt: number;
    /** 人能看懂的原因（不含凭证、不含内容） */
    reason: string;
    /** HTTP 状态或平台的风控码 */
    code?: string | number;
}

/** 熔断中：请求在发出之前就被拦下，没有碰网络 */
export class BreakerOpen extends Error {
    readonly state: BreakerState;
    constructor(state: BreakerState) {
        super(`${state.platform} 已熔断（${state.reason}），要人在本机运行 platform resume 才会恢复`);
        this.name = 'BreakerOpen';
        this.state = state;
    }
}

export interface PlatformBreaker {
    readonly platform: string;
    /** 熔断中就抛 BreakerOpen */
    check(): void;
    /** 熔断。已经熔断的不覆盖（保留最早的原因） */
    trip(reason: string, code?: string | number): void;
    state(): BreakerState | undefined;
    /** 只给命令行用：人确认过之后恢复 */
    resume(): void;
}

export interface BreakerOptions {
    /** 数据目录；状态存在 <dataDir>/platforms/<平台>/breaker.json */
    dataDir: string;
    platform: string;
    now?: () => number;
    log?: (message: string) => void;
}

export const breakerPath = (dataDir: string, platform: string) => join(dataDir, 'platforms', platform, 'breaker.json');

const validState = (value: unknown): value is BreakerState | null =>
    value === null || (typeof value === 'object' && typeof (value as BreakerState).platform === 'string' && typeof (value as BreakerState).trippedAt === 'number' && typeof (value as BreakerState).reason === 'string');

export function createBreaker(options: BreakerOptions): PlatformBreaker {
    const { platform } = options;
    const path = breakerPath(options.dataDir, platform);
    const now = options.now ?? Date.now;
    const log = options.log ?? (() => undefined);
    // 每次都读盘：命令行在另一个进程里恢复之后，运行中的机器人下一次请求就能看到
    const load = (): BreakerState | undefined => readJsonOr<BreakerState | null>(path, null, log, { validate: validState, label: `${platform} 熔断状态` }) ?? undefined;
    return {
        platform,
        check() {
            const state = load();
            if (state) throw new BreakerOpen(state);
        },
        trip(reason, code) {
            if (load()) return;
            const state: BreakerState = { platform, trippedAt: now(), reason, ...(code !== undefined ? { code } : {}) };
            mkdirSync(dirname(path), { recursive: true });
            writeJsonAtomic(path, state);
            log(`${platform} 熔断：${reason}${code !== undefined ? `（${code}）` : ''}。之后所有请求都不发了；要人在本机运行 platform resume ${platform} --acknowledge-account-risk 才会恢复`);
        },
        state: load,
        resume() {
            mkdirSync(dirname(path), { recursive: true });
            writeJsonAtomic(path, null);
            log(`${platform} 熔断已由人恢复`);
        },
    };
}

/** 一次请求的结果里，哪些算风控 */
export interface RiskRule {
    /** 这些 HTTP 状态算风控 */
    statuses: readonly number[];
    /** 返回的 JSON 里 code 是这些算风控 */
    codes: readonly number[];
}

/** 最小的请求 / 响应形状（B 站和以后的平台都满足） */
export interface GuardedResponse {
    ok: boolean;
    status: number;
    text(): Promise<string>;
}

/**
 * 给一个请求函数包一层：发之前先看熔断，发完看有没有风控信号，有就熔断并抛 BreakerOpen。
 * 响应体读出来之后原样还给调用方（text() 可以再读），所以不影响各平台自己的解析。
 */
export function guardRequest<I, R extends GuardedResponse>(
    request: (url: string, init: I) => Promise<R>,
    breaker: PlatformBreaker,
    rule: RiskRule,
): (url: string, init: I) => Promise<R> {
    return async (url, init) => {
        breaker.check();
        const response = await request(url, init);
        if (rule.statuses.includes(response.status)) {
            breaker.trip(`HTTP ${response.status}`, response.status);
            breaker.check();
        }
        const text = await response.text();
        // 只有长得像 JSON 的才看 code；字幕文件、HTML 页面原样放行
        if (text.startsWith('{')) {
            let code: unknown;
            try { code = (JSON.parse(text) as { code?: unknown }).code; } catch { /* 不是 JSON 就不管 */ }
            if (typeof code === 'number' && rule.codes.includes(code)) {
                breaker.trip(`风控码 ${code}`, code);
                breaker.check();
            }
        }
        return new Proxy(response, { get: (target, key) => (key === 'text' ? async () => text : Reflect.get(target, key, target)) }) as R;
    };
}

/** B 站：412 / 403 / 429 和 -352（风控校验失败）-412（请求被拦截）-799（请求过于频繁）-509（频繁）；-101（没登录）不算，那是凭证的事 */
export const BILIBILI_RISK: RiskRule = { statuses: [403, 412, 429], codes: [-352, -412, -799, -509] };
