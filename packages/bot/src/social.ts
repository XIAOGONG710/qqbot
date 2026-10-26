// 小红书、抖音的共用部分（ADR 0166）：帖子的统一形状、计数文字解析、风控判断、内存守卫、浏览的节奏。
// 各平台怎么读页面在 social-xhs.ts / social-douyin.ts；浏览器怎么开在 browser-cdp.ts；熔断在 platform-breaker.ts。

import { freemem } from 'node:os';
import type { Page } from './browser-cdp.ts';
import type { PlatformBreaker } from './platform-breaker.ts';

export type Platform = 'xhs' | 'douyin';
export const PLATFORMS: readonly Platform[] = ['xhs', 'douyin'];
export const PLATFORM_NAME: Record<Platform, string> = { xhs: '小红书', douyin: '抖音' };
export const isPlatform = (value: unknown): value is Platform => value === 'xhs' || value === 'douyin';

/** 她看到的一条内容（帖子 / 视频）。别人写的，只当素材 */
export interface SocialPost {
    platform: Platform;
    id: string;
    /** 能在浏览器里直接打开、也能发给他的真链接 */
    url: string;
    kind: 'video' | 'image';
    title: string;
    /** 正文 / 简介（列表里读不到，点开才有） */
    text: string;
    author: string;
    likes?: number;
    commentCount?: number;
    /** 秒 */
    durationS?: number;
    tags: string[];
    /** 热评（点开才有），每条已截短 */
    comments: string[];
    /** 发布时间，毫秒（读得到才有） */
    postedAt?: number;
    /** 小红书打开详情要带的凭据（页面自己给的，随列表一起来） */
    xsec?: string;
}

/** 「8万」「1.2万」「3611」「10w+」「1亿」→ 数字；读不懂返回 undefined */
export function parseCount(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const match = /^\s*(\d+(?:\.\d+)?)\s*([万wW亿]?)\s*\+?\s*$/.exec(value);
    if (!match) return undefined;
    const base = Number(match[1]);
    const unit = match[2] === '亿' ? 1e8 : match[2] ? 1e4 : 1;
    return Math.round(base * unit);
}

/** 「14:55」「1:02:03」→ 秒 */
export function parseDuration(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const match = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(value);
    if (!match) return undefined;
    return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** 把别人写的文字弄成一行：去换行、方括号（会和占位符搞混）、多余空白，截短 */
export function clip(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const text = value.replace(/[\r\n\t]+/g, ' ').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim();
    return [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text;
}

// ───────── 风控 ─────────

/** 这些 HTTP 状态出在平台自己的地址上就算风控（461 / 471 是小红书的验证 / 限制） */
export const RISK_STATUSES: readonly number[] = [403, 429, 461, 471];

/**
 * 页面上明确的验证 / 风控文字。小红书的登录框里本来就有「验证码」，所以不拿「验证码」当信号。
 * 只在「该有的内容没读到」的时候才拿页面文字来比，不然一篇正文里写了「账号异常」的笔记就会让整个平台熔断。
 */
export const RISK_TEXT = /安全验证|拖动滑块|滑动完成验证|完成下方验证|完成下列验证|验证后继续|访问(?:过于)?频繁|请求(?:过于)?频繁|操作(?:过于)?频繁|IP\s*存在风险|网络环境存在风险|账号(?:存在)?异常|账号已被(?:限制|封|冻结)|行为异常/;

export function riskInText(text: string): string | undefined {
    return RISK_TEXT.exec(text.slice(0, 20_000))?.[0];
}

export interface RiskGuard {
    /** 每次导航 / 滚动之前：熔断中就抛 BreakerOpen，不碰网络 */
    before(): void;
    /** 现在起收到的响应的序号（传给 after） */
    mark(): number;
    /** 导航 / 滚动之后：平台自己的地址出了风控状态就熔断（并抛 BreakerOpen） */
    afterStatuses(since: number): void;
    /** 该有的内容没读到时调用：页面上有明确的风控文字就熔断（并抛 BreakerOpen）；没有就返回，调用方当普通失败处理 */
    afterMissing(): Promise<void>;
}

export function createRiskGuard(page: Page, breaker: PlatformBreaker, hosts: RegExp): RiskGuard {
    return {
        before: () => breaker.check(),
        mark: () => page.mark(),
        afterStatuses(since) {
            for (const response of page.responses(hosts, since)) {
                if (RISK_STATUSES.includes(response.status)) {
                    breaker.trip(`HTTP ${response.status}（${new URL(response.url).host}）`, response.status);
                    breaker.check();
                }
            }
        },
        async afterMissing() {
            const text = await page.evaluate<string>(`(document.body && document.body.innerText || '').slice(0, 20000)`).catch(() => '');
            const hit = riskInText(text);
            if (hit) { breaker.trip(`页面出现「${hit}」`); breaker.check(); }
        },
    };
}

// ───────── 内存守卫、节奏 ─────────

/** 开一次浏览器要 410–460 MB（10-26 实测，关图片后），虚拟机 6 GB、平时空闲 800–1700 MB：低于这个就这次不开 */
export const MIN_FREE_BYTES = 900 * 1024 * 1024;
export const memoryOk = (free: number = freemem()): boolean => free >= MIN_FREE_BYTES;

export interface Pacing {
    sleep(ms: number): Promise<void>;
    /** [0,1) */
    random(): number;
}
export const realPacing: Pacing = { sleep: ms => new Promise(done => setTimeout(done, ms)), random: Math.random };

/** 两次动作之间停 minMs–maxMs（带抖动），像人 */
export const pause = (pacing: Pacing, minMs: number, maxMs: number): Promise<void> => pacing.sleep(Math.round(minMs + pacing.random() * (maxMs - minMs)));

/** 一次会话里最多做几次导航（含打开首页、搜索、点开详情） */
export const SESSION_NAV_MAX = 12;

/** 导航预算用完了：这次会话到此为止（不是风控，不熔断） */
export class BudgetExhausted extends Error {
    constructor() { super('这次会话的导航次数用完了'); this.name = 'BudgetExhausted'; }
}

export interface NavBudget { take(): void; readonly left: number }
export function createNavBudget(max: number = SESSION_NAV_MAX): NavBudget {
    let left = max;
    return { take() { if (left <= 0) throw new BudgetExhausted(); left -= 1; }, get left() { return left; } };
}

/** 隔 stepMs 问一次 probe，最多问 ceil(timeoutMs / stepMs) 次，问到有结果就返回；一直没有返回 undefined（次数而不是时钟，测试里睡眠是瞬间的） */
export async function waitFor<T>(pacing: Pacing, probe: () => Promise<T | undefined | null | false>, timeoutMs: number, stepMs = 500): Promise<T | undefined> {
    for (let i = 0; i <= Math.ceil(timeoutMs / stepMs); i++) {
        const value = await probe().catch(() => undefined);
        if (value) return value;
        await pacing.sleep(stepMs);
    }
    return undefined;
}
/** 每次滚轮往下滚多少像素 */
export const SCROLL_PX = 700;

/** 读不到东西的原因：登录没过、该有的内容没读到 */
export class SocialReadError extends Error {
    readonly kind: 'notLoggedIn' | 'missing';
    constructor(message: string, kind: 'notLoggedIn' | 'missing') {
        super(message);
        this.name = 'SocialReadError';
        this.kind = kind;
    }
}

/** 读者：一个平台一个，开在一个已经打开的页面上 */
export interface SocialReader {
    readonly platform: Platform;
    /** 当前登录了没有（会打开首页） */
    status(): Promise<{ loggedIn: boolean; detail: string }>;
    /** 刷首页：往下滚 screens 屏，返回刷到的（去重，列表信息，没有正文） */
    feed(screens: number): Promise<SocialPost[]>;
    /** 按关键词搜 */
    search(keyword: string, screens: number): Promise<SocialPost[]>;
    /** 点开一条：读正文、热评；视频停几秒、截几帧 */
    open(post: SocialPost, options: { watchMs: number; frames: number }): Promise<{ post: SocialPost; frames: Buffer[] }>;
}

/** 按 id 去重，保持先后顺序 */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
    const seen = new Set<string>();
    return items.filter(item => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}
