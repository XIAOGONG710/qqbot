import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { describePast, parseBiography, pastCue, PAST_CHUNKS, type Biography } from '../src/biography.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const biography: Biography = {
    timeline: ['2019–2022：初中，和他同班、同桌好几年', '2022–2025：高中，和他同校不同班'],
    chunks: [
        { id: 'deskmate', title: '初中同桌', keys: ['初中', '同桌', '数学'], text: '初中我们同桌了好几年。他数学好，我听不懂就找他要答案。' },
        { id: 'senior', title: '高三那一年', keys: ['高三'], gap: 'refuse', text: '高三那一年状态很糟。' },
        { id: 'why', title: '为什么都在这儿', keys: ['同一个学校', '分数'], gap: 'unsaid', text: '你们都说分数只够这里。' },
        { id: 'school', title: '高中', keys: ['高中'], text: '高中我们同校不同班。' },
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
        assert.match(text, /- 高三那一年：高三那一年状态很糟。（这段你不想讲：/);
        assert.match(text, /- 为什么都在这儿：你们都说分数只够这里。（这是你心里的事，不说出口）/);
        assert.match(text, /你的年表：2019–2022：初中，和他同班、同桌好几年；2022–2025：高中，和他同校不同班$/);
        assert.ok(!text.includes('同一个学校'), 'keys 不进提示词');
        assert.equal(describePast([], biography), undefined);
    });

    test('卡上的格式：不对就报错；没有就是 undefined', () => {
        assert.equal(parseBiography(undefined, 'x'), undefined);
        assert.throws(() => parseBiography({ timeline: [] }, 'x'), /timeline/);
        assert.throws(() => parseBiography({ timeline: [], chunks: [{ id: 'a', title: 'b', keys: ['c'], text: 'd', gap: 'forgot' }] }, 'x'), /gap/);
    });

    test('真卡：男朋友档看得到全部 19 块（含留白）；同学档只有土豆，问初中想不起什么', () => {
        const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).biography!;
        assert.equal(boyfriend.chunks.length, 19);
        assert.deepEqual(pastCue([he('你初中是不是天天抄我作业')], boyfriend).map(c => c.id).slice(0, 1), ['deskmate']);
        assert.deepEqual(pastCue([he('高三那年你咋了')], boyfriend).map(c => c.gap), ['refuse']);
        const classmate = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-classmate.json')).biography!;
        assert.deepEqual(classmate.chunks.map(c => c.id), ['potato']);
        assert.deepEqual(pastCue([he('你初中在哪上的')], classmate), []);
    });
});
