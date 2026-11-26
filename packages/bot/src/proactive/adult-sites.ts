// 成人网站访问从用户填入的 HTTPS 页面开始，站内作品链接只认已知的格式。
import { dropComments, dropTagBlocks, readPage, type PageDeps } from '../platform/web.ts';

export const ADULT_SITE_SATISFACTION_THRESHOLD = 45;
const ATTEMPT_INTERVAL_MS = 24 * 60 * 60_000;
const STORY_PATHS = new Map([
    ['www.literotica.com', /^\/s\/[a-z0-9-]+\/?$/i],
    ['storiesonline.net', /^\/s\/\d+(?:\/[a-z0-9-]+)?\/?$/i],
    ['www.lushstories.com', /^\/stories\/[a-z0-9-]+\/[a-z0-9-]+\/?$/i],
]);

function firstStoryLink(html: string, page: URL, storyPath: RegExp): string | undefined {
    // 线性写法（2026-11-26 审查 W8，同 web.ts 的 W3）：原来的正则遇到一串没收尾的 <!-- / <script / <a 会平方级地扫
    const cleaned = dropTagBlocks(dropComments(html), ['script', 'style', 'template']);
    const body = cleaned.slice(0, cleaned.lastIndexOf('>') + 1);
    for (const anchor of body.matchAll(/<a\s+[^>]*>/gi)) {
        const href = /\s+href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/i.exec(anchor[0]);
        const address = href?.[1] ?? href?.[2] ?? href?.[3];
        if (!address) continue;
        const url = URL.parse(address, page.href);
        if (!url || url.origin !== page.origin || url.username || url.password || !storyPath.test(url.pathname)) continue;
        return new URL(url.pathname, page.origin).href;
    }
}

export async function readAdultSite(entry: URL, deps: Pick<PageDeps, 'fetch' | 'resolve' | 'signal'>): Promise<boolean> {
    const read = { ...deps, allowedOrigin: entry.origin };
    const storyPath = STORY_PATHS.get(entry.hostname);
    if (!storyPath) return (await readPage(entry.href, read)).ok;

    let story = entry;
    if (!storyPath.test(entry.pathname)) {
        const directory = entry.hostname === 'www.literotica.com' && /^\/stories\/?$/.test(entry.pathname)
            ? new URL('/new/stories', entry.origin) : entry;
        const listing = await readPage(directory.href, { ...read, pickLink: (html, page) => firstStoryLink(html, page, storyPath) });
        if (!listing.ok || !listing.nextLink || deps.signal?.aborted) return false;
        story = new URL(listing.nextLink);
    }
    const page = await readPage(story.href, { ...read, allowedPath: story.pathname });
    return page.ok && !/to read the complete story you need to be logged in/i.test(page.text);
}

export function adultSiteUrls(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10) throw new Error('adultSiteUrls 应为最多 10 个 HTTPS 网页地址的数组');
    const urls = value.map(item => {
        const url = typeof item === 'string' ? URL.parse(item) : null;
        if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) {
            throw new Error('adultSiteUrls 只接受 HTTPS 网页地址，不带端口、账号、查询参数或片段');
        }
        return url.href;
    });
    return [...new Set(urls)];
}

export function adultSiteVisitDue(satisfaction: number | undefined, lastAttemptAt: string | undefined, now: number): boolean {
    if (satisfaction === undefined || !Number.isFinite(satisfaction) || satisfaction >= ADULT_SITE_SATISFACTION_THRESHOLD) return false;
    return lastAttemptAt === undefined || now - Date.parse(lastAttemptAt) >= ATTEMPT_INTERVAL_MS;
}
