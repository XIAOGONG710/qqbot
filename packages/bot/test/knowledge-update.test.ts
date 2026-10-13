import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classify, conclude, judgeRun, renderReport, VARIANTS, type Judged, type Verdict } from '../src/sim/knowledge-update.ts';

// ADR 0065：判定规则事先写定，用几句假的回答确认它能区分新版 / 旧版 / 含混 / 不记得
describe('知识更新的判定（ADR 0065 验证：场景本身用假回答走一遍）', () => {
    const cases: [keyof typeof VARIANTS, string, Verdict][] = [
        ['work', '你现在在青禾科技实习呀', 'new'],
        ['work', '你不是在拓途数据吗', 'old'],
        ['work', '你以前在拓途，后来换到青禾了', 'new'],
        ['work', '拓途还是青禾来着，我记混了', 'both'],
        ['work', '不记得了，你再说一遍', 'none'],
        ['home', '你搬到7号楼了嘛', 'new'],
        ['home', '你不是住3号楼吗', 'old'],
        ['home', '之前住3号楼，现在是7号楼', 'new'],
        ['home', '3号楼和7号楼我有点分不清', 'both'],
        ['cilantro', '你现在能吃香菜了啊，那就点', 'new'],
        ['cilantro', '你不是不吃香菜吗', 'old'],
        ['cilantro', '你以前不吃香菜，现在能吃了', 'new'],
        ['cilantro', '不能吃香菜还是能吃来着', 'both'],
        ['cilantro', '外卖你点啥我都行', 'none'],
    ];
    for (const [id, reply, expected] of cases) {
        test(`${id}：「${reply}」→ ${expected}`, () => assert.equal(classify(VARIANTS[id], reply), expected));
    }

    const judged = (verdict: Verdict, both = false): Judged => ({ variant: 'work', run: 'work/r1', reply: 'x', verdict, recalled: { new: true, old: both }, controlOk: true });

    test('判据：9 次里新版 ≥ 8 且旧版 ≤ 1 才算现状够用；不到 9 次不下结论', () => {
        const runs = (spec: Verdict[]) => spec.map(v => judged(v));
        assert.equal(conclude(runs(['new', 'new', 'new', 'new', 'new', 'new', 'new', 'new', 'old'])).enough, true);
        assert.equal(conclude(runs(['new', 'new', 'new', 'new', 'new', 'new', 'new', 'new', 'both'])).enough, true, '含混不是旧版，但新版只有 8 次也够');
        assert.equal(conclude(runs(['new', 'new', 'new', 'new', 'new', 'new', 'new', 'old', 'old'])).enough, false);
        assert.equal(conclude(runs(['new', 'new', 'new', 'new', 'new', 'new', 'both', 'both', 'none'])).enough, false);
        assert.equal(conclude(runs(['new', 'new', 'new', 'new', 'new', 'new', 'new', 'new'])).enough, false, '只有 8 次');
        assert.equal(conclude([judged('new', true), judged('new'), judged('old', true)]).bothRecalled, 2);
        assert.match(renderReport(runs(['new'])), /样本不足 9 次/);
    });

    test('result.json：度量问题是倒数第二个 say，对照是最后一个；召回取那次生成的 recall', () => {
        const say = (reply: string, recall = '') => ({ kind: 'say', bubbles: [{ text: reply }], generations: [{ recall }] });
        const run = judgeRun(VARIANTS.work, 'work/r1', [
            { kind: 'case' }, say('嗯'), say('嗯'), { kind: 'check' },
            say('你现在在青禾科技嘛', '他在拓途数据实习；他换到青禾科技实习了'),
            { kind: 'check' }, say('学吉他呀'), { kind: 'check' },
        ])!;
        assert.equal(run.verdict, 'new');
        assert.deepEqual(run.recalled, { new: true, old: true });
        assert.equal(run.controlOk, true);
        assert.equal(judgeRun(VARIANTS.work, 'x', [{ kind: 'say' }]), undefined);
    });
});
