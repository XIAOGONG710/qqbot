import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLOSE_DAYS, CLOSE_WINDOW_DAYS, describeCloseness, TALK_DAY_MIN_MESSAGES, talkDays } from '../src/relationship.ts';

// ADR 0113：关系阶段——最近 30 天里“真聊过”的天数
const DAY = 86_400_000;
const base = new Date(2026, 10, 20, 12, 0).getTime();
type Msg = { role: 'user' | 'assistant'; time: string };
/** 往回第 n 天，他说了 count 条（她各回一条） */
const day = (n: number, count: number): Msg[] => Array.from({ length: count }, (_, i) => [
    { role: 'user' as const, time: new Date(base - n * DAY + i * 60_000).toISOString() },
    { role: 'assistant' as const, time: new Date(base - n * DAY + i * 60_000 + 20_000).toISOString() },
]).flat();
const chats = (days: number[], count = TALK_DAY_MIN_MESSAGES): Msg[] => days.flatMap(n => day(n, count));

describe('关系阶段', () => {
    test('真聊过的天：他那天至少说了 3 条；一句“在吗”不算；她说的不算；窗口外的不算', () => {
        assert.equal(talkDays(chats([1, 2, 3]), base), 3);
        assert.equal(talkDays(chats([1, 2, 3], 2), base), 0, '每天只说 2 条');
        assert.equal(talkDays([...chats([1]), ...day(2, 1)], base), 1);
        assert.equal(talkDays(chats([CLOSE_WINDOW_DAYS + 1, CLOSE_WINDOW_DAYS + 5]), base), 0, '30 天之外');
        assert.equal(talkDays(chats([CLOSE_WINDOW_DAYS - 1]), base), 1, '30 天之内');
        const onlyHers: Msg[] = Array.from({ length: 6 }, (_, i) => ({ role: 'assistant' as const, time: new Date(base - DAY + i * 1000).toISOString() }));
        assert.equal(talkDays(onlyHers, base), 0);
    });

    test('攒够 CLOSE_DAYS 天才多一行；不够就和现在一样（不变冷）；不存分数，窗口一滑就回去', () => {
        const days = Array.from({ length: CLOSE_DAYS }, (_, i) => i + 1);
        const line = describeCloseness(chats(days), base);
        assert.ok(line, '够了');
        assert.ok(line!.includes(`已经聊了 ${CLOSE_DAYS} 天`) && line!.includes('更放得开一点') && line!.includes('别突然变得黏人腻歪'), line);
        assert.equal(describeCloseness(chats(days.slice(1)), base), undefined, '少一天');
        assert.equal(describeCloseness([], base), undefined, '没聊过：基线');
        assert.equal(describeCloseness(chats(days), base + 20 * DAY), undefined, '20 天没聊，窗口里不够了：回到基线');
        assert.doesNotMatch(line!, /[「」]/, '不给台词');
    });

    test('没有时间戳的、未来的消息不算', () => {
        const noTime = [{ role: 'user' as const }, { role: 'user' as const }, { role: 'user' as const }];
        assert.equal(talkDays(noTime, base), 0);
        const future: Msg[] = [0, 1, 2].map(i => ({ role: 'user' as const, time: new Date(base + DAY + i * 1000).toISOString() }));
        assert.equal(talkDays(future, base), 0);
    });
});
