import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TREND_MIN_BUBBLES, TREND_WEEKS, WEEK_MS, describeTrend, speechTrend } from '../src/language/speech-trend.ts';
import { speechStats } from '../src/language/speech-notes.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const NOW = new Date(2026, 9, 30, 23, 0, 0).getTime();
const DAY = 86_400_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });
/** daysAgo 那天他说一句、她回 texts */
const turn = (daysAgo: number, texts: string[]): StoredMessage[] => {
    const at = NOW - daysAgo * DAY;
    return [row('user', '在吗', at - 5000), ...texts.map((text, i) => row('assistant', text, at + i * 1000))];
};

describe('她说话的样子按周看', () => {
    test('从新到旧每周一个窗口：最近 7 天、7–14 天前…，每周数自己那一周的话', () => {
        const messages = [
            ...turn(30, ['一', '二', '三', '四', '五', '六']),                                   // 28–35 天前
            ...turn(22, ['好的呀', '知道啦', '嗯嗯', '晚安啦', '早点睡', '哈哈哈']),            // 21–28 天前
            ...turn(15, ['在呢', '怎么啦', '哦', '好', '行', '嗯']),                             // 14–21 天前
            ...turn(8, ['辛苦了', '早点歇着呀', '别太晚', '明天见', '睡吧', '晚安']),           // 7–14 天前
            ...turn(1, ['哈', '哈哈', '真的假的', '笑死我了', '你好笨', '😂']),                  // 最近 7 天
        ];
        const windows = speechTrend(messages, NOW);
        assert.equal(windows.length, TREND_WEEKS);
        assert.deepEqual(windows.map(window => window.label), ['最近 7 天', '7–14 天前', '14–21 天前', '21–28 天前']);
        assert.deepEqual(windows.map(window => window.bubbles), [6, 6, 6, 6], '第 5 周（28 天前以外）的不算');
        assert.equal(windows[0]!.stats!.shortShare, 3 / 6, '最近一周：哈 / 哈哈 / 😂 三个两字以内');
        assert.equal(windows[0]!.stats!.emojiShare, 1 / 6);
        assert.equal(windows[1]!.stats!.shortShare, 2 / 6, '前一周：睡吧 / 晚安 两个');
        assert.equal(windows[1]!.stats!.emojiShare, 0, '每周数的是自己那一周的，不是混在一起');
    });

    test('一周里不到 6 个气泡：只有条数，没有比例；没说话：0 条', () => {
        const windows = speechTrend([...turn(1, ['哈', '嗯', '好']), ...turn(8, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])], NOW);
        assert.equal(windows[0]!.bubbles, 3);
        assert.equal(windows[0]!.stats, undefined);
        assert.equal(windows[1]!.bubbles, 7);
        assert.ok(windows[1]!.stats);
        assert.equal(windows[2]!.bubbles, 0);
        assert.equal(windows[2]!.stats, undefined);
        assert.equal(TREND_MIN_BUBBLES, 6);
    });

    test('边界不重复数：刚好在两周交界上的一条只算一次；未来的、运维写进记录的行不算', () => {
        const edge = NOW - WEEK_MS;
        const messages = [
            row('user', '在吗', edge - 5000), row('assistant', '边界上', edge),
            row('assistant', '[B 站私信] 视频（《x》）', NOW - 1000), row('assistant', '[你戳了戳他]', NOW - 900),
            row('assistant', '未来的', NOW + DAY),
        ];
        const windows = speechTrend(messages, NOW);
        assert.equal(windows[0]!.bubbles + windows[1]!.bubbles, 1);
        assert.equal(windows[0]!.bubbles, 1, '刚好 7 天前的算在「最近 7 天」');
    });

    test('describeTrend：以「（」开头；每周一行；够多才列数字；真人的参照在后面；写明只是监测、没有目标线', () => {
        const messages = [...turn(1, ['哈', '哈哈', '真的假的', '笑死我了', '你好笨', '😂']), ...turn(8, ['a', 'b', 'c'])];
        const real = speechStats([['在', '怎么啦'], ['嗯'], ['好', '行']])!;
        const text = describeTrend(speechTrend(messages, NOW), real);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /最近 7 天（6 条）：一次回 6 条；每条中位 3 个字/);
        assert.match(text, /7–14 天前（3 条）：太少了，数出来的比例不当数/);
        assert.match(text, /14–21 天前：没怎么说话/);
        assert.match(text, /真人女生的参照（来自 5 条真实语料）：一次回 1.67 条/);
        assert.match(text, /没有目标线，不会拿去卡她，也不是评分/);
        assert.match(text, /她每晚想说话习惯的时候看到的，是最近 3 天的这一组数字/);
        assert.doesNotMatch(describeTrend(speechTrend(messages, NOW)), /真人女生的参照/, '没有语料就没有这一段');
    });
});
