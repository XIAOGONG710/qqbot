import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastJournalEntry, wakeBackfill, WAKE_GAP_MS, BACKFILL_MAX_CHARS } from '../src/memory/wake-backfill.ts';

const JOURNAL = `# 日记

## 2026-10-27
昨天没干什么正事，把剧看完了。

## 2026-10-29
今天睡睡醒醒，把《药屋少女的呢喃》剩下的几卷看完了。夜里他又不肯睡，先嘱咐我早点睡，转头自己在那儿翻旧账。他先睡的，我躺着又想了半天。
`;

test('取日记最后一段', () => {
    const entry = lastJournalEntry(JOURNAL);
    assert.equal(entry?.date, '2026-10-29');
    assert.ok(entry?.text.startsWith('今天睡睡醒醒'));
    assert.equal(lastJournalEntry('没有日期的正文'), undefined);
});

test('离开不到 6 小时不铺', () => {
    const now = Date.parse('2026-10-29T10:00:00+08:00');
    const lastAt = new Date(now - WAKE_GAP_MS + 60_000).toISOString();
    assert.equal(wakeBackfill({ lastAt, now, journal: JOURNAL }), undefined);
});

test('离开超过 6 小时就铺，且带上她写的那段', () => {
    const now = Date.parse('2026-10-29T10:00:00+08:00');
    const lastAt = new Date(now - 11 * 3_600_000).toISOString();
    const line = wakeBackfill({ lastAt, now, journal: JOURNAL });
    assert.ok(line?.includes('走了 11 小时'), line ?? '空');
    assert.ok(line?.includes('睡睡醒醒'), line ?? '空');
    assert.ok([...line!].length <= BACKFILL_MAX_CHARS + 40, `太长：${[...line!].length}`);
});

test('没有聊天记录、没有日记都不铺', () => {
    const now = Date.parse('2026-10-29T10:00:00+08:00');
    assert.equal(wakeBackfill({ lastAt: undefined, now, journal: JOURNAL }), undefined);
    assert.equal(wakeBackfill({ lastAt: new Date(now - 9 * 3_600_000).toISOString(), now, journal: '' }), undefined);
});
