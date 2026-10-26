// 读者测试用的假页面（不是 *.test.ts，不会被当成测试跑）：不开浏览器，evaluate 按表达式回话，响应由测试自己推。
import type { Page } from '../src/browser-cdp.ts';

export interface FakeEvent { url: string; status: number }

export interface FakePage extends Page {
    gotos: string[];
    wheels: number[];
    shots: number;
    events: FakeEvent[];
}

export function fakePage(options: {
    evaluate: (expression: string, page: FakePage) => unknown;
    /** 每次导航之后调用：可以往 events 里推响应（比如 461） */
    onGoto?: (url: string, page: FakePage) => void;
    onWheel?: (page: FakePage) => void;
    screenshotFails?: boolean;
    cookies?: string[];
    /** 按响应地址给响应体（读详情 / 评论用） */
    bodies?: Array<{ match: RegExp; body: string | (() => Promise<string>) }>;
}): FakePage {
    const page: FakePage = {
        gotos: [], wheels: [], shots: 0, events: [],
        async goto(url) { page.gotos.push(url); options.onGoto?.(url, page); },
        async evaluate<T>(expression: string) { return options.evaluate(expression, page) as T; },
        mark: () => page.events.length,
        async waitForResponse() { return undefined; },
        responses: (match, since = 0) => page.events.slice(since).filter(event => match.test(event.url)).map(event => ({
            url: event.url, status: event.status,
            body: async () => { const found = options.bodies?.find(entry => entry.match.test(event.url)); if (!found) return ''; return typeof found.body === 'string' ? found.body : found.body(); },
        })),
        async cookieNames() { return options.cookies ?? []; },
        async wheel(deltaY) { page.wheels.push(deltaY); options.onWheel?.(page); },
        async screenshot() { if (options.screenshotFails) throw new Error('截不了'); page.shots += 1; return Buffer.from(`jpeg-${page.shots}`); },
        url: async () => page.gotos.at(-1) ?? '',
        async close() { /* 无 */ },
    };
    return page;
}

/** 睡眠瞬间完成、随机数固定的节奏 */
export const fastPacing = { sleep: async () => undefined, random: () => 0.5 };
