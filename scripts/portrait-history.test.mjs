import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describe, readPortrait, sentenceDiff } from './portrait-history.mjs';

// 只读工具：她每一版「我现在的样子」改了什么、为什么（ADR 0340）。数据是编的。

const V1 = '我说话挺爱带哈哈的。喜欢逗人。';
const V2 = '我说话挺爱带哈哈的，但想认真接话时少用。喜欢逗人。';
const V3 = '我说话挺爱带哈哈的，但想认真接话时少用。喜欢逗人。最近愿意说烦心事了。';

test('按句子比：加了什么、去掉了什么', () => {
    assert.deepEqual(sentenceDiff(V1, V2), { added: ['我说话挺爱带哈哈的，但想认真接话时少用。'], removed: ['我说话挺爱带哈哈的。'] });
});

test('从第一版到现在：每一版的日期和为什么改，没收的原因，现在这份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portrait-history-'));
    try {
        const at = day => new Date(2026, 10, day, 23).getTime();
        writeFileSync(join(dir, 'self-portrait.json'), JSON.stringify({ text: V3, at: at(21), version: 3, why: '想把烦心事说出来', rejected: { at: at(22), reason: '写得像检讨了' } }));
        writeFileSync(join(dir, 'self-portrait.history.jsonl'), [
            JSON.stringify({ text: V1, at: at(19), version: 1, why: '他嫌我老哈哈', replacedAt: at(20) }),
            JSON.stringify({ text: V2, at: at(20), version: 2, why: '想把烦心事说出来', replacedAt: at(21) }),
            '坏的一行',
        ].join('\n'));
        const text = describe(readPortrait(dir));
        assert.match(text, /第 1 版（2026-11-19）\n我说话挺爱带哈哈的。喜欢逗人。/);
        assert.match(text, /第 2 版（2026-11-20）：他嫌我老哈哈\n  - 我说话挺爱带哈哈的。\n  \+ 我说话挺爱带哈哈的，但想认真接话时少用。/);
        assert.match(text, /第 3 版（2026-11-21）：想把烦心事说出来\n  \+ 最近愿意说烦心事了。/);
        assert.match(text, /上次想改、没成（2026-11-22）：写得像检讨了/);
        assert.match(text, /现在这份（第 3 版）/);
        assert.match(describe(readPortrait(dir), 1), /^── 第 3 版（2026-11-21）：想把烦心事说出来\n我说话挺爱带哈哈的，但想认真接话时少用/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('还没写过就直说', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portrait-history-'));
    try { assert.match(describe(readPortrait(dir)), /还没写过/); } finally { rmSync(dir, { recursive: true, force: true }); }
});
