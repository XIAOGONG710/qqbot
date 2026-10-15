import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { FeedbackRow } from '../src/feedback.ts';
import { feedbackDigest, readFeedback } from '../src/feedback-digest.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const NOW = new Date(2026, 9, 15, 20, 0, 0);
let nextId = 1;
const row = (daysAgo: number, label: 'fake' | 'real', her: string[], context: FeedbackRow['context'] = []): FeedbackRow =>
    ({ at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), label, messageId: nextId++, herMessageId: 1, her, context, tier: 'boyfriend' });

test('按天数假 / 像；被说「假」的那几轮带前面两条上下文；窗口外的不算', () => {
    const text = feedbackDigest([
        row(20, 'fake', ['太老的']),
        row(2, 'fake', ['哎呀你真是的', '烦死了'], [{ role: 'user', text: '在干嘛' }, { role: 'assistant', text: '刚醒' }, { role: 'user', text: '早' }]),
        row(2, 'real', ['哈哈哈哈']),
        row(1, 'fake', ['您好，有什么可以帮您']),
    ], NOW, 7);
    assert.match(text, /共 3 条：假 2、像 1/);
    assert.doesNotMatch(text, /太老的/);
    assert.match(text, /哎呀你真是的」「烦死了/);
    assert.match(text, /前文　她：刚醒/);
    assert.match(text, /前文　他：早/);
    assert.doesNotMatch(text, /在干嘛/, '只带前面两条');
    assert.match(text, /\| \d{4}-\d{2}-\d{2} \| 1 \| 1 \|/);
    assert.match(text, /对照用/);
});

test('这段时间没有反馈：说明一句，不崩', () => {
    assert.match(feedbackDigest([], NOW, 7), /这段时间没有反馈/);
    assert.match(feedbackDigest([row(30, 'fake', ['x'])], NOW, 7), /共 0 条/);
});

test('读文件：按时间排序，坏行和没有标签的行跳过，没有目录返回空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-feedback-digest-'));
    dirs.push(dir);
    assert.deepEqual(readFeedback(dir), []);
    mkdirSync(join(dir, 'feedback'));
    const later = row(1, 'real', ['b']);
    const earlier = row(3, 'fake', ['a']);
    appendFileSync(join(dir, 'feedback', '2026-10.jsonl'), `${JSON.stringify(later)}\nnot json\n${JSON.stringify({ at: later.at, label: 'meh', her: [] })}\n${JSON.stringify(earlier)}\n`);
    assert.deepEqual(readFeedback(dir).map(r => r.her[0]), ['a', 'b']);
});
