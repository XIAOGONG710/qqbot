// 她每天刷一小会儿 B 站推荐（ADR 0168 第 2 期接线）：照 watching.ts 的形状——一天一次、14 点后、有「今天做过了」的记账。
// 只读：拿一页推荐 → 排一次会话（停 / 划走）→ 存今天刷到的（标题 / 分区 / 停留秒数），不播视频、不点赞、不评论。
// dryRun 只写 presence/drafts.md，不进状态文件；读不到（风控 / 签名变了）只记一行。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fetchRecommend, planSession, sessionSize } from './bilibili-feed.ts';
import type { BiliFetch } from './bilibili-view.ts';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export interface FeedVisit { bvid: string; title: string; category: string; seconds: number }
export interface FeedRecord { day: string; at: number; mode: 'dryRun' | 'on'; stayed: FeedVisit[]; skipped: number }
export interface FeedFile { version: 1; seen: string[]; days: FeedRecord[] }

export const FEED_FROM_HOUR = 14;
export const FEED_KEEP_DAYS = 30;
export const FEED_SEEN_MAX = 300;
const MS_DAY = 86_400_000;

export const feedPath = (dataDir: string): string => join(dataDir, 'watching', 'feed.json');

const dayText = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayNumber = (text: string): number => { const [y, m, d] = text.split('-').map(Number) as [number, number, number]; return Math.floor(Date.UTC(y, m - 1, d) / MS_DAY); };

export function loadFeed(path: string, log: (message: string) => void = () => undefined): FeedFile {
    const raw = readJsonOr<Partial<FeedFile>>(path, {}, message => log(`刷 B 站：${message}`));
    const seen = Array.isArray(raw.seen) ? raw.seen.filter((id): id is string => typeof id === 'string') : [];
    const days = Array.isArray(raw.days)
        ? raw.days.filter((record): record is FeedRecord => Boolean(record) && typeof record.day === 'string' && Array.isArray(record.stayed))
            .map(record => ({
                day: record.day,
                at: typeof record.at === 'number' ? record.at : 0,
                mode: record.mode === 'on' ? 'on' as const : 'dryRun' as const,
                stayed: record.stayed.filter(visit => Boolean(visit) && typeof visit.bvid === 'string').slice(0, 12),
                skipped: typeof record.skipped === 'number' ? record.skipped : 0,
            }))
        : [];
    return { version: 1, seen, days };
}

export function saveFeed(path: string, file: FeedFile): void {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, file);
}

/** 过期的去掉、最多 30 天；seen 只留最近 300 个 */
export function trimFeed(file: FeedFile, now: Date): FeedFile {
    const today = dayNumber(dayText(now));
    return {
        version: 1,
        seen: file.seen.slice(-FEED_SEEN_MAX),
        days: file.days.filter(record => today - dayNumber(record.day) <= FEED_KEEP_DAYS).sort((a, b) => a.day.localeCompare(b.day)).slice(-FEED_KEEP_DAYS),
    };
}

/** 今天该不该刷：14 点后、今天还没有记录（dryRun 也算做过，免得一天反复抓） */
export function feedDue(file: FeedFile, now: Date): boolean {
    return now.getHours() >= FEED_FROM_HOUR && !file.days.some(record => record.day === dayText(now));
}

export interface FeedDeps {
    mode: 'dryRun' | 'on';
    path: string;
    now: () => Date;
    fetch: BiliFetch;
    log: (message: string) => void;
    /** dryRun 的草稿落点（presence/drafts.md） */
    draft?: (title: string, body: string) => void;
    /** 这会儿方不方便刷（睡着 / 上课返回 false）；不给就一直方便 */
    awake?: (now: Date) => boolean;
}

export type FeedOutcome = 'browsed' | 'done' | 'skipped';

/** 刷一次：拿一页推荐、排会话、记账。读不到返回 'skipped'（由调用方记一行） */
export async function feedOnce(deps: FeedDeps): Promise<FeedOutcome> {
    const now = deps.now();
    const file = loadFeed(deps.path, deps.log);
    if (!feedDue(file, now)) return 'done';
    if (deps.awake && !deps.awake(now)) return 'done';
    const day = dayText(now);
    let items;
    try {
        items = await fetchRecommend(deps.fetch, { count: 8 });
    } catch (error) {
        deps.log(`刷 B 站：推荐读不到（${error instanceof Error ? error.message : String(error)}）`);
        return 'skipped';
    }
    const session = planSession(items, file.seen, day, sessionSize(day));
    if (!session.stayed.length) {
        deps.log(`刷 B 站：这一页没有对口的（${session.visited.length} 个都划走了）`);
        return 'skipped';
    }
    const stayed: FeedVisit[] = session.stayed.map(entry => ({ bvid: entry.item.bvid, title: entry.item.title.slice(0, 60), category: entry.item.category.slice(0, 10), seconds: entry.seconds }));
    if (deps.mode === 'dryRun') {
        const body = stayed.map(entry => `- 停 ${entry.seconds} 秒：《${entry.title}》${entry.category ? `（${entry.category}）` : ''}`).join('\n');
        deps.draft?.(`${now.toLocaleString('zh-CN')} 刷 B 站（草稿，不记录）`, body);
        deps.log(`刷 B 站（试运行）：停 ${stayed.length} 个，写了草稿`);
        return 'browsed';
    }
    const record: FeedRecord = { day, at: now.getTime(), mode: 'on', stayed, skipped: session.skipped.length };
    saveFeed(deps.path, trimFeed({ version: 1, seen: [...file.seen, ...session.visited.map(item => item.bvid)], days: [...file.days, record] }, now));
    deps.log(`刷 B 站：今天停了 ${stayed.length} 个（划走 ${session.skipped.length} 个），记下了`);
    return 'browsed';
}

/** 同上，但带 id：给内心用（想过一次就不再反复想同一件） */
export function feedFactEntry(file: FeedFile, now: Date): { id: string; text: string } | undefined {
    const text = feedFacts(file, now);
    if (!text) return undefined;
    const today = dayText(now);
    const record = file.days.findLast(day => day.day === today && day.mode === 'on');
    const entry = record?.stayed[0];
    return entry ? { id: `feed:${entry.bvid}`, text } : undefined;
}

/** 她心里想事情时可用的「今天刷到过」；没有就 undefined（一天只给一条，免得她老提同一个） */
export function feedFacts(file: FeedFile, now: Date): string | undefined {
    const today = dayText(now);
    const record = file.days.findLast(day => day.day === today && day.mode === 'on');
    const entry = record?.stayed[0];
    if (!entry) return undefined;
    return `你今天在 B 站刷到过《${entry.title}》${entry.category ? `（${entry.category}）` : ''}，停了 ${entry.seconds} 秒`;
}
