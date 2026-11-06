import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describePast, parseBiography, pastCue, PAST_CHUNKS, type Biography } from '../src/life/biography.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const biography: Biography = {
    timeline: ['2018–2021：初中，和他在一个数学兴趣小组', '2021–2024：高中，和他在两个城市'],
    chunks: [
        { id: 'deskmate', title: '数学兴趣小组', keys: ['初中', '同桌', '数学'], text: '初中我们在一个数学兴趣小组。每次做题他都比我快一点，我不服气。' },
        { id: 'senior', title: '高三那一年', keys: ['高三'], gap: 'refuse', text: '高三那一年总是睡不好。' },
        { id: 'why', title: '为什么都在这儿', keys: ['同一个学校', '分数'], gap: 'unsaid', text: '你们都说是凑巧填了同一所。' },
        { id: 'school', title: '高中', keys: ['高中'], text: '高中我们在两个城市，靠写信联系。' },
    ],
};
const he = (content: string) => ({ role: 'user' as const, content });
const she = (content: string) => ({ role: 'assistant' as const, content });

describe('她的过去：有线索才想起（ADR 0022 第 2 步）', () => {
    test('他这次的话里有 keys 才想起；她回过以后的才算', () => {
        assert.deepEqual(pastCue([he('你初中数学是不是很烂')], biography).map(c => c.id), ['deskmate']);
        assert.deepEqual(pastCue([he('初中的事'), she('咋了'), he('没事')], biography), [], '线索在她上次回复之前');
        assert.deepEqual(pastCue([he('在干嘛')], biography), []);
        assert.deepEqual(pastCue([], biography), []);
    });

    test(`最多 ${PAST_CHUNKS} 块，命中的词长的在前，一样长按资料顺序`, () => {
        const ids = pastCue([he('咱俩怎么考到同一个学校的，高中、高三那会儿你也不说，初中的时候')], biography).map(c => c.id);
        assert.equal(ids.length, PAST_CHUNKS);
        assert.deepEqual(ids, ['why', 'deskmate'], '「同一个学校」最长；「初中」「高中」「高三」一样长按顺序');
    });

    test('提示词：素材不是台词；留白带说明；附年表；没有就不放', () => {
        const text = describePast(pastCue([he('高三那年你怎么了'), he('还有为什么考到一个学校，分数够吗')], biography), biography)!;
        assert.match(text, /^\[你想起的从前（你自己的事，只是素材不是台词；他问到、话赶到了才用，用你自己的话挑要紧的说；用不上就别提，没写到的细节别编）\]/);
        assert.match(text, /- 高三那一年：高三那一年总是睡不好。（这段你不想讲：/);
        assert.match(text, /- 为什么都在这儿：你们都说是凑巧填了同一所。（这是你心里的事，不说出口）/);
        assert.match(text, /你的年表：2018–2021：初中，和他在一个数学兴趣小组；2021–2024：高中，和他在两个城市$/);
        assert.ok(!text.includes('同一个学校'), 'keys 不进提示词');
        assert.equal(describePast([], biography), undefined);
    });

    test('卡上的格式：不对就报错；没有就是 undefined', () => {
        assert.equal(parseBiography(undefined, 'x'), undefined);
        assert.throws(() => parseBiography({ timeline: [] }, 'x'), /timeline/);
        assert.throws(() => parseBiography({ timeline: [], chunks: [{ id: 'a', title: 'b', keys: ['c'], text: 'd', gap: 'forgot' }] }, 'x'), /gap/);
    });

    test('合成卡：男朋友档看得到全部 5 块（含留白）；同学档只有小时候的猫和不想聊的那段，问老家想不起什么', () => {
        const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend')).biography!;
        assert.equal(boyfriend.chunks.length, 5);
        assert.deepEqual(pastCue([he('你小时候是不是养过猫')], boyfriend).map(c => c.id).slice(0, 1), ['childhood-cat']);
        assert.deepEqual(pastCue([he('你以前谈过吗')], boyfriend).map(c => c.gap), ['refuse']);
        const classmate = loadCharacterCard(syntheticCardPath('classmate')).biography!;
        assert.deepEqual(classmate.chunks.map(c => c.id), ['childhood-cat', 'old-story']);
        assert.deepEqual(pastCue([he('你老家在哪')], classmate), []);
    });
});
