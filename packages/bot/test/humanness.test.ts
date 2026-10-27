import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { auc, bubbleFeatures, FEATURE_NAMES, featureEffects, humanProbability, trainModel } from '../src/language/humanness.ts';

const f = (text: string, name: (typeof FEATURE_NAMES)[number]) => bubbleFeatures(text)[FEATURE_NAMES.indexOf(name)]!;

describe('像不像真人：写法特征', () => {
    test('特征和名字一一对应；[表情] 记号不算字数', () => {
        assert.equal(bubbleFeatures('好的').length, FEATURE_NAMES.length);
        assert.equal(f('好的[doge]', 'len_le2'), 1);
        assert.equal(f('好的[doge]', 'has_face'), 1);
        assert.equal(f('好的', 'has_face'), 0);
    });

    test('长短、收尾标点、逗号和分句', () => {
        assert.equal(f('嗯嗯', 'len_le4'), 1);
        assert.equal(f('一二三四五六七八九十一二三四五六', 'len_ge15'), 1);
        assert.equal(f('好的。', 'end_period'), 1);
        assert.equal(f('真的假的？', 'end_question'), 1);
        assert.equal(f('好的', 'end_none'), 1);
        assert.equal(f('今天好累，作业还没写，烦死了', 'comma_count'), 2);
        assert.equal(f('今天好累，作业还没写，烦死了', 'multi_clause'), 1);
        assert.equal(f('好累', 'multi_clause'), 0);
    });

    test('语气词、哈哈、叠词、连接词、以「我」开头', () => {
        assert.equal(f('你吃了吗', 'part_ma'), 1);
        assert.equal(f('是这样呢', 'part_ne'), 1);
        assert.equal(f('哈哈哈哈', 'has_haha'), 1);
        assert.equal(f('嗯嗯', 'repeat_char'), 1);
        assert.equal(f('我觉得不过还是算了', 'starts_wo'), 1);
        assert.ok(f('其实我觉得但是还是算了', 'connective') >= 2);
    });
});

describe('像不像真人：AUC 和训练', () => {
    test('AUC：完全分开 1、完全反过来 0、分数全一样 0.5', () => {
        assert.equal(auc([{ score: 0.1, y: 0 }, { score: 0.2, y: 0 }, { score: 0.8, y: 1 }, { score: 0.9, y: 1 }]), 1);
        assert.equal(auc([{ score: 0.9, y: 0 }, { score: 0.8, y: 0 }, { score: 0.2, y: 1 }, { score: 0.1, y: 1 }]), 0);
        assert.equal(auc([{ score: 0.5, y: 0 }, { score: 0.5, y: 1 }, { score: 0.5, y: 0 }, { score: 0.5, y: 1 }]), 0.5);
        assert.ok(Number.isNaN(auc([{ score: 0.5, y: 1 }])));
    });

    test('训练：长句、带逗号的「她」和短句的「真人」分得开；权重指出的是长度和逗号；像真人的概率排序对', () => {
        const humans = ['嗯嗯', '在干嘛', '好的呀', '真的假的', '哈哈哈', '我也是', '等下', '啊？', '行吧', '好累啊', '睡了', '不知道', '是吗', '我吃了', '随便', '算了吧'];
        const hers = ['今天真的好累啊，而且还要写作业，烦死了。', '我觉得这件事其实不太容易，不过可以慢慢来。', '你说得对，但是我还是想再考虑一下。', '没关系的，我会一直在这里陪着你的。', '明天要早起，所以我今晚打算早点休息。', '其实我也有同样的感受，只是不知道怎么说。'];
        const rows = [...humans.map(text => ({ x: bubbleFeatures(text), y: 1 as const })), ...hers.map(text => ({ x: bubbleFeatures(text), y: 0 as const }))];
        const model = trainModel(rows);
        const scores = rows.map(row => ({ score: humanProbability(model, row.y === 1 ? humans[rows.indexOf(row)]! : hers[rows.indexOf(row) - humans.length]!), y: row.y }));
        assert.ok(auc(scores) > 0.99);
        assert.ok(humanProbability(model, '好的呀') > humanProbability(model, '其实我觉得这件事不太容易，不过可以慢慢来。'));
        const top = featureEffects(model).slice(0, 6).map(effect => effect.name);
        assert.ok(top.some(name => ['len_log', 'comma_count', 'clause_count', 'len_ge15', 'len_le4', 'len_le8', 'end_period'].includes(name)), top.join(','));
    });
});
