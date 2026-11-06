import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildJudgePrompt, checkReplies, recentReplies } from '../src/language/selfcheck.ts';

describe('人格自检（ADR 0167）', () => {
    test('取最近十条她的回复：跳过非文字、跳过他的话', () => {
        const rows = [
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在呢' },
            { role: 'assistant', content: '[图片表情]' },
            { role: 'assistant', content: '刚睡醒' },
        ];
        assert.deepEqual(recentReplies(rows, 10), ['在呢', '刚睡醒']);
        assert.deepEqual(recentReplies(rows, 1), ['刚睡醒']);
    });

    test('规则层：禁用词、助手腔、句号、长句、问句、开头重复各报一条', () => {
        const replies = [
            '首先，你要先照顾好自己。',
            '希望对你有帮助哦。',
            '好的，我来帮你看看。',
            '当然可以，我们一起分析一下这个问题吧。',
            '你在干嘛？',
            '你吃饭了吗？',
            '你睡了吗？',
            '你还好吗？',
            '我觉得这个问题需要从多个角度来看，首先你要明确目标，其次要拆解步骤。',
            '那个……',
            '那个……',
            '那个……',
        ];
        const findings = checkReplies({ replies, banned: ['照顾好自己'], maxChars: 12 });
        const rules = new Set(findings.map(finding => finding.rule));
        assert.ok(rules.has('banned'), '禁用词');
        assert.ok(rules.has('assistant_tone'), '助手腔');
        assert.ok(rules.has('period_end'), '句号');
        assert.ok(rules.has('too_long'), '长句');
        assert.ok(rules.has('too_many_questions'), '问句');
        assert.ok(rules.has('same_opener'), '开头重复');
        for (const finding of findings) {
            assert.ok(finding.examples.every(text => text.length <= 15), '例子截短');
        }
    });

    test('干净的十条：一条都不报', () => {
        const replies = ['在呢', '刚睡醒', '食堂吃了', '你呢', '笑死', '外面下雨了', '不想出门', '团子饼在踩我', '晚点说', '困了'];
        assert.deepEqual(checkReplies({ replies }), []);
    });

    test('模型层提示词：不带他的话、逐条编号、要 JSON', () => {
        const prompt = buildJudgePrompt({ name: '林梦瑶', description: '20 岁女大学生', personality: '嘴硬心软' }, ['在呢', '好的，我来帮你']);
        assert.match(prompt, /1\. 在呢/);
        assert.match(prompt, /2\. 好的，我来帮你/);
        assert.match(prompt, /"verdicts"/);
        assert.equal(prompt.includes('user:'), false);
    });
});
