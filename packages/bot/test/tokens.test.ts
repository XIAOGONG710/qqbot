import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { estimateTokens } from '../src/language/tokens.ts';

// 直接测 tokens.ts：UTF-8 字节数 / 3.35，向上取整（ST guesstimate 同款）。
describe('estimateTokens（UTF-8 字节数 / 3.35 向上取整）', () => {
    test('正例：ASCII / 中文 / emoji / 中英混排按 UTF-8 字节数算', () => {
        assert.equal(estimateTokens('hello'), 2); // 5 字节 -> ceil(5/3.35)=2
        assert.equal(estimateTokens('你好'), 2); // 6 字节（每字 3 字节）-> 2
        assert.equal(estimateTokens('😀'), 2); // 4 字节 emoji -> 2
        assert.equal(estimateTokens('a你'), 2); // 1 + 3 = 4 字节 -> 2
        assert.equal(estimateTokens('abc'), 1); // 3 字节 -> 1
    });

    test('空输入：空串是 0，不是 1', () => {
        assert.equal(estimateTokens(''), 0);
    });

    test('取整边界：1 字节进 1 个 token，335 字节正好 100，336 字节进 101', () => {
        assert.equal(estimateTokens('a'), 1);
        assert.equal(estimateTokens('x'.repeat(335)), 100);
        assert.equal(estimateTokens('x'.repeat(336)), 101);
    });

    test('超长文本：一万字节按公式给 2986，且不是逐字计数', () => {
        const long = 'x'.repeat(10_000);
        assert.equal(estimateTokens(long), 2986);
        assert.ok(estimateTokens(long) < long.length);
    });

    test('同样的文本多次调用结果一致，更长的文本不会估得更少', () => {
        const a = '今天天气不错，出去走走';
        assert.equal(estimateTokens(a), estimateTokens(a));
        assert.ok(estimateTokens(`${a}${a}`) >= estimateTokens(a));
    });
});
