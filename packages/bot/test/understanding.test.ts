import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isCorrection, recordCorrection, understandingLine } from '../src/life/understanding.ts';

// 10-30：让她自己学习去理解人说的话——他纠正时记下来，下次同一件事提醒她
describe('她理解人的话', () => {
    test('认得出他在纠正；平常的话不算', () => {
        for (const text of ['不是这个意思', '我说的是明天，不是今天', '你理解错了', '我没这么说']) assert.equal(isCorrection(text), true, text);
        for (const text of ['在吗', '好的', '我明天来', '今天好累啊']) assert.equal(isCorrection(text), false, text);
    });

    test('记下来；同一句纠正只留最后一次；撞上才提醒', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-understanding-'));
        try {
            const now = Date.UTC(2026, 9, 30, 11, 0, 0);
            recordCorrection(dir, { his: '我明天去图书馆', her: '你今天就去了？', fix: '我说的是明天，不是今天' }, now);
            // 同一个事件再说一遍：留最后一次
            recordCorrection(dir, { his: '我明天去图书馆', her: '你今天去了吧', fix: '我说的是明天，不是今天' }, now + 1000);
            const hit = understandingLine(dir, '我明天去图书馆吗', now + 2000);
            assert.match(hit!, /以前理解偏过/);
            assert.match(hit!, /明天，不是今天/);
            // 不撞：没有共享两个二字词
            assert.equal(understandingLine(dir, '今天天气不错', now + 2000), undefined);
            // 过期：30 天以后不再提
            assert.equal(understandingLine(dir, '我明天去图书馆吗', now + 31 * 86_400_000), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('空目录当没有，不抛', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-understanding-'));
        try {
            assert.equal(understandingLine(dir, '随便说点什么', Date.now()), undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
