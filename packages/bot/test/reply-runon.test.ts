import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitReply, splitRunOn } from '../src/language/reply.ts';

// 2026-10-30 线上：「行、我听进去了就是这些话别忽然整太多我会晕这个」——一口气顶下来，没有像样的停顿
test('一口气顶下来的长句拆成两条；有逗号句号的不动', () => {
    const parts = splitRunOn('行、我听进去了就是这些话别忽然整太多我会晕这个');
    assert.equal(parts.length, 2, JSON.stringify(parts));
    assert.ok(parts.every(p => p.length > 0));
    assert.deepEqual(splitRunOn('这句有逗号，所以不动它尽管它真的很长很长'), ['这句有逗号，所以不动它尽管它真的很长很长']);
    assert.deepEqual(splitRunOn('短句'), ['短句']);
});

test('拆分发生在整条回复里：长跑句变两泡，正常的两行还是两泡', () => {
    const bubbles = splitReply('行、我听进去了就是这些话别忽然整太多我会晕这个\n好');
    assert.equal(bubbles.length, 3, JSON.stringify(bubbles));
});
