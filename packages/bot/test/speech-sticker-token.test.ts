import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSpeech } from '../src/language/speech-check.ts';

// 2026-11-14 真事：她抽到「只发表情」，出口检查把 <sticker:aaf263734791> 当成
// 「最近说过原话」，切掉开头只剩 aaf263734791> 发给了他。
test('贴纸编号不进出口检查，不会被切成半截', () => {
    const context = { recent: [['<sticker:aaf263734791>']], his: [], allowRepeat: false } as never;
    const issues = inspectSpeech('<sticker:aaf263734791>', context);
    assert.equal(issues.length, 0, JSON.stringify(issues));
});
