import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchSingRequest } from '../src/voice/sing.ts';

describe('唱歌触发（2026-11-14）', () => {
    test('「唱 BVxxxx」认出来', () => {
        assert.equal(matchSingRequest('唱 BV1hW4y1Y7dG'), 'BV1hW4y1Y7dG');
        assert.equal(matchSingRequest('翻唱一首 BV1hW4y1Y7dG'), 'BV1hW4y1Y7dG');
        assert.equal(matchSingRequest('给我唱：BV1hW4y1Y7dG 吧'), 'BV1hW4y1Y7dG');
    });

    test('直接贴链接不算点歌，明确让她唱才认', () => {
        const link = 'https://www.bilibili.com/video/BV1hW4y1Y7dG/?x=1';
        assert.equal(matchSingRequest(link), undefined);
        assert.equal(matchSingRequest('唱 ' + link), 'BV1hW4y1Y7dG');
    });

    test('歌名：书名号或「唱 」开头', () => {
        assert.equal(matchSingRequest('唱 稻香'), '稻香');
        assert.equal(matchSingRequest('给我唱一首 稻香'), '稻香');
        assert.equal(matchSingRequest('唱《晴天》'), '晴天');
    });

    test('「我想听《X》」「来首 X」也认', () => {
        assert.equal(matchSingRequest('宝宝，我想听《海屿你》'), '海屿你');
        assert.equal(matchSingRequest('想听海屿你'), '海屿你');
        assert.equal(matchSingRequest('来一首 晴天'), '晴天');
        assert.equal(matchSingRequest('我想听你说话'), undefined);
    });

    test('日常说法也认（2026-11-14 实测他这么说的）', () => {
        assert.equal(matchSingRequest('宝宝，在唱首心似烟火呗'), '心似烟火');
        assert.equal(matchSingRequest('唱个晴天'), '晴天');
        assert.equal(matchSingRequest('翻唱一下 后来 吧'), '后来');
    });

    test('普通聊天不误触', () => {
        assert.equal(matchSingRequest('今天好累'), undefined);
        assert.equal(matchSingRequest('唱歌好听'), undefined);
        assert.equal(matchSingRequest('唱吧'), undefined);
        assert.equal(matchSingRequest('唱歌'), undefined);
        assert.equal(matchSingRequest('我刚读完《三体》'), undefined);
        assert.equal(matchSingRequest('你看过《流浪地球》吗'), undefined);
        assert.equal(matchSingRequest('我想听一下你的意见'), undefined);
        assert.equal(matchSingRequest('我想听你的看法'), undefined);
    });
});
