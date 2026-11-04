import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memeLine, trimMemes, type MemeEntry } from '../src/language/memes.ts';
import { trimWatched, watchDue, watchedFacts, type Watched } from '../src/language/watching.ts';
import { feedDue, trimFeed, type FeedFile, type FeedRecord } from '../src/bilibili/feed-browsing.ts';

const at = (day: string) => new Date(`${day}T15:00:00`);
const meme = (day: string): MemeEntry => ({ term: '合成梗', meaning: '用于轻松闲聊的合成意思', example: '随便聊聊', confidence: 'high', firstSeen: day, lastSeen: day, seen: 1 });
const watched = (day: string): Watched => ({ bvid: 'BV-test', title: '合成视频', owner: '合成UP', tname: '日常', excerpt: '合成字幕内容', hot: [], day });
const record = (day: string): FeedRecord => ({ day, at: at(day).getTime(), mode: 'on', stayed: [], skipped: 0 });
const feed = (days: string[]): FeedFile => ({ version: 1, seen: [], days: days.map(record) });

test('0099跨0100后，早已过期的梗、观看记录和推荐记录不会被当成未来而永久保留', () => {
    const now = at('0100-03-01');
    assert.deepEqual(trimMemes([meme('0099-12-31'), meme('0100-02-28')], now).map(item => item.lastSeen), ['0100-02-28']);
    assert.deepEqual(trimWatched([watched('0099-12-31'), watched('0100-02-28')], now).map(item => item.day), ['0100-02-28']);
    assert.deepEqual(trimFeed(feed(['0099-12-31', '0100-02-28']), now).days.map(item => item.day), ['0100-02-28']);
});

test('过期的上世纪内容不会出现在最近看过事实或最近热梗提示里', () => {
    const now = at('0100-03-01');
    assert.equal(watchedFacts([watched('0099-12-31')], now), undefined);
    let sampled = false;
    for (let i = 0; i < 100; i++) {
        const history = [{ role: 'user' as const, content: `随便聊聊今天的事情${i}`, time: now.toISOString() }];
        // 通过公开行为找到本轮会给出“最近梗”的采样，不复制内部随机算法。
        if (!memeLine([meme('0100-03-01')], history, now.getTime())) continue;
        assert.equal(memeLine([meme('0099-12-31')], history, now.getTime()), undefined);
        sampled = true; break;
    }
    assert.ok(sampled);
});

test('低年份今日记录采用四位日期，观看和刷推荐仍保证同日只做一次', () => {
    for (const day of ['0000-02-29', '0099-12-31', '0100-01-01']) {
        assert.equal(watchDue([watched(day)], at(day)), false, day);
        assert.equal(feedDue(feed([day]), at(day)), false, day);
        assert.equal(trimWatched([watched(day)], at(day)).length, 1);
        assert.equal(trimFeed(feed([day]), at(day)).days.length, 1);
    }
});

test('0000年是闰年，过期截止按实际天数而不是1900非闰年计算', () => {
    const now = at('0000-03-01');
    assert.deepEqual(trimMemes([meme('0000-01-15'), meme('0000-01-16')], now).map(item => item.lastSeen), ['0000-01-16']);
    assert.deepEqual(trimWatched([watched('0000-01-30'), watched('0000-01-31')], now).map(item => item.day), ['0000-01-31']);
    assert.deepEqual(trimFeed(feed(['0000-01-30', '0000-01-31']), now).days.map(item => item.day), ['0000-01-31']);
});

test('现代45天和30天保留边界、3天新鲜度以及每日去重保持不变', () => {
    const now = at('2026-11-05');
    assert.deepEqual(trimMemes([meme('2026-09-20'), meme('2026-09-21')], now).map(item => item.lastSeen), ['2026-09-21']);
    assert.deepEqual(trimWatched([watched('2026-10-05'), watched('2026-10-06')], now).map(item => item.day), ['2026-10-06']);
    assert.deepEqual(trimFeed(feed(['2026-10-05', '2026-10-06']), now).days.map(item => item.day), ['2026-10-06']);
    assert.ok(watchedFacts([watched('2026-11-02')], now));
    assert.equal(watchedFacts([watched('2026-11-01')], now), undefined);
    assert.equal(watchDue([watched('2026-11-05')], now), false);
    assert.equal(feedDue(feed(['2026-11-05']), now), false);
});
