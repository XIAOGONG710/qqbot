import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { feedDue, feedFactEntry, feedFacts, feedOnce, loadFeed, saveFeed, trimFeed } from '../src/bilibili/feed-browsing.ts';
import type { BiliFetch } from '../src/bilibili/bilibili-view.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-feed-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (h: number, m = 0) => new Date(2026, 9, 27, h, m);

/** nav + rcmd 的假实现：推荐里两个对口、一个新闻、一个凶案标题 */
const fakeFetch = (calls: string[] = []): BiliFetch => async url => {
    calls.push(url);
    if (url.includes('/nav')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://x/a' + 'a'.repeat(30) + '.png', sub_url: 'https://x/b' + 'b'.repeat(30) + '.png' } } }) };
    return {
        ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { item: [
            { bvid: 'BV1aa411c7mD', title: '楼下三花的一天', owner: { name: '小雨' }, duration: 120, stat: { view: 10 } },
            { bvid: 'BV1bb411c7mD', title: '凌晨的食堂', owner: { name: '阿明' }, duration: 90, stat: { view: 5 } },
            { bvid: 'BV1cc411c7mD', title: '今天新闻', tname: '时事新闻', duration: 300 },
            { bvid: 'BV1dd411c7mD', title: '每十年杀一个同学', duration: 600 },
        ] } }),
    };
};

describe('她每天刷一小会儿 B 站（ADR 0168）', () => {
    test('14 点后、今天没刷过才刷；dryRun 只写草稿、不记账', async () => {
        const dir = tmp();
        const path = join(dir, 'watching/feed.json');
        const drafts: string[] = [];
        const outcome = await feedOnce({ mode: 'dryRun', path, now: () => at(15), fetch: fakeFetch(), log: () => undefined, draft: (_title, body) => drafts.push(body) });
        assert.equal(outcome, 'browsed');
        assert.equal(drafts.length, 1);
        assert.match(drafts[0]!, /楼下三花的一天/);
        assert.equal(existsSync(path), false, '试运行不落状态');
        const early = await feedOnce({ mode: 'on', path, now: () => at(9), fetch: fakeFetch(), log: () => undefined });
        assert.equal(early, 'done');
    });

    test('开着：记账、seen 累加、当天只刷一次；凶案标题被划走', async () => {
        const dir = tmp();
        const path = join(dir, 'watching/feed.json');
        const calls: string[] = [];
        const first = await feedOnce({ mode: 'on', path, now: () => at(15), fetch: fakeFetch(calls), log: () => undefined });
        assert.equal(first, 'browsed');
        const file = loadFeed(path);
        assert.equal(file.days.length, 1);
        assert.equal(file.days[0]!.mode, 'on');
        assert.ok(file.days[0]!.stayed.every(visit => !visit.title.includes('杀')));
        assert.ok(file.seen.length >= 2);
        const twice = await feedOnce({ mode: 'on', path, now: () => at(16), fetch: fakeFetch(calls), log: () => undefined });
        assert.equal(twice, 'done');
        assert.match(feedFacts(file, at(16)) ?? '', /刷到过《/);
        assert.equal(feedFacts(file, new Date(2026, 9, 28, 16)), undefined);
    });

    test('读不到推荐：skipped，不记账、不重复刷', async () => {
        const dir = tmp();
        const path = join(dir, 'watching/feed.json');
        const broken: BiliFetch = async () => { throw new Error('code -352'); };
        const outcome = await feedOnce({ mode: 'on', path, now: () => at(15), fetch: broken, log: () => undefined });
        assert.equal(outcome, 'skipped');
        assert.equal(existsSync(path), false);
        assert.equal(feedDue(loadFeed(path), at(15)), true, '失败不占今天的名额');
    });

    test('30 天后清掉旧记录；seen 最多留 300', () => {
        const file = { version: 1 as const, seen: Array.from({ length: 305 }, (_, i) => `BV${i}`), days: [{ day: '2026-09-01', at: 0, mode: 'on' as const, stayed: [], skipped: 0 }, { day: '2026-10-27', at: 0, mode: 'on' as const, stayed: [], skipped: 0 }] };
        const trimmed = trimFeed(file, at(15));
        assert.equal(trimmed.seen.length, 300);
        assert.deepEqual(trimmed.days.map(day => day.day), ['2026-10-27']);
    });
});

describe('刷到的进内心（ADR 0168）', () => {
    test('带 id、只认当天开着的那条、dryRun 不算', () => {
        const entry = feedFactEntry({
            version: 1,
            seen: [],
            days: [
                { day: '2026-10-26', at: 0, mode: 'on', stayed: [{ bvid: 'BVold', title: '昨天的', category: '', seconds: 60 }], skipped: 0 },
                { day: '2026-10-27', at: 0, mode: 'dryRun', stayed: [{ bvid: 'BVdry', title: '草稿的', category: '', seconds: 60 }], skipped: 0 },
            ],
        }, at(16));
        assert.equal(entry, undefined);
        const withOn = feedFactEntry({
            version: 1,
            seen: [],
            days: [{ day: '2026-10-27', at: 0, mode: 'on', stayed: [{ bvid: 'BVnow', title: '楼下三花的一天', category: '喵星人', seconds: 90 }], skipped: 1 }],
        }, at(16));
        assert.deepEqual(withOn?.id, 'feed:BVnow');
        assert.match(withOn?.text ?? '', /楼下三花的一天/);
    });
});
