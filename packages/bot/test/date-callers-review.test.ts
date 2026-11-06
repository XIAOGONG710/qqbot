import assert from 'node:assert/strict';
import { test } from 'node:test';
import { when } from '../src/language/time-context.ts';
import { whenText } from '../src/memory/timeline.ts';
import { todayStart } from '../src/emotion/disclosure.ts';
import { localIso } from '../src/memory/episodes.ts';

test('世界日期跨 0099→0100 年时，提示词和近期时间线仍将前一日称为昨天', () => {
    const now = new Date('0100-01-01T12:00:00');
    const before = new Date('0099-12-31T12:00:00');
    assert.equal(when(before, now), '昨天 12:00');
    assert.equal(whenText(before, now), '昨天 12:00');
});

test('无课表时披露计日从真实低年份本地零点开始', () => {
    const day = todayStart(undefined, new Date('0099-11-05T17:30:00'));
    assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours(), day.getMinutes()], [99, 10, 5, 0, 0]);
});

test('回忆时间戳保留四位低年份与真实时刻，不受历史秒级时区偏移干扰', () => {
    for (const text of ['0000-02-29T12:30:00Z', '0099-11-05T12:30:00Z', '0100-01-01T12:30:00Z', '2026-11-05T12:30:00Z']) {
        const at = new Date(text);
        assert.equal(Date.parse(localIso(at)), at.getTime());
    }
    assert.equal(localIso(new Date('2026-11-05T12:30:00Z')).startsWith('2026-'), true);
});
