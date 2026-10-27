import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSummary } from '../src/bilibili/bilibili-summary.ts';

describe('B 站 AI 总结（ADR 0168 第 2.5 期）', () => {
    test('认 model_result：summary + outline（章节 + 要点时间戳）', () => {
        const summary = parseSummary({
            model_result: {
                summary: '这期讲了怎么用三分钟做一顿饭。',
                outline: [
                    { title: '开场', part_outline: [{ timestamp: 0, content: '先洗菜' }, { timestamp: 30, content: '切菜' }] },
                    { title: '正题', part_outline: [{ timestamp: 60, content: '下锅' }] },
                ],
            },
        })!;
        assert.equal(summary.summary, '这期讲了怎么用三分钟做一顿饭。');
        assert.equal(summary.chapters.length, 2);
        assert.deepEqual(summary.chapters[1]!.points, [{ at: 60, text: '下锅' }]);
    });

    test('空结果 / 只有大纲 / 字段形状不对，都不假装有总结', () => {
        assert.equal(parseSummary({}), undefined);
        assert.equal(parseSummary({ model_result: {} }), undefined);
        assert.equal(parseSummary({ model_result: { summary: '' } }), undefined);
        const outlineOnly = parseSummary({ model_result: { outline: [{ title: '只有标题' }] } });
        assert.equal(outlineOnly?.summary, '');
        assert.equal(outlineOnly?.chapters[0]?.points.length, 0);
        assert.equal(parseSummary(null), undefined);
    });

    test('长文本截断：总述 400 字、要点 80 字', () => {
        const summary = parseSummary({ model_result: { summary: '长'.repeat(900), outline: [{ title: 'x', part_outline: [{ timestamp: 1, content: '点'.repeat(300) }] }] } })!;
        assert.equal([...summary.summary].length, 400);
        assert.equal([...summary.chapters[0]!.points[0]!.text].length, 80);
    });
});
