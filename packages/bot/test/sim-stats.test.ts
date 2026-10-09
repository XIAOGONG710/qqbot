import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dialogueShape } from '../src/sim/stats.ts';

describe('模拟器的真人基线同口径统计', () => {
    test('按一轮实际发出的气泡数分桶，空轮不进入分母', () => {
        const stats = dialogueShape([
            ['嗯'],
            ['你去吧', '我等你'],
            ['一', '二', '三'],
            ['一', '二', '三', '四'],
            ['一', '二', '三', '四', '五'],
            [],
        ]);
        assert.equal(stats.replyTurns, 5);
        assert.deepEqual(stats.bubblesPerReply, { one: 1, two: 1, three: 1, fourPlus: 2 });
    });

    test('字数按 Unicode 码点，分位数取 nearest rank', () => {
        const stats = dialogueShape([['a', '中文', 'abc', '四个字符', '12345', '六个字符呀啊', '1234567', '12345678']]);
        assert.deepEqual(stats.bubbleChars, { median: 4, p75: 6, p90: 8 });
        assert.equal(dialogueShape([['😀']]).bubbleChars.median, 1);
    });

    test('问句率沿用真人基线的句末定义', () => {
        const stats = dialogueShape([['你呢', '好吗', '行吧', '真的？', 'really?', '好吗。', '不是']]);
        assert.equal(stats.questionBubbles, 5);
        assert.equal(stats.questionRate, 5 / 7);
    });

    test('没有发出回复时所有指标为零', () => {
        assert.deepEqual(dialogueShape([[], []]), {
            replyTurns: 0,
            bubblesPerReply: { one: 0, two: 0, three: 0, fourPlus: 0 },
            bubbleChars: { median: 0, p75: 0, p90: 0 },
            questionBubbles: 0,
            questionRate: 0,
        });
    });
});
