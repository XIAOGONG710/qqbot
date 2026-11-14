import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchSingRequest } from '../src/voice/sing.ts';

describe('唱歌触发（2026-11-14）', () => {
    test('「唱 BVxxxx」认出来', () => {
        assert.equal(matchSingRequest('唱 BV1hW4y1Y7dG'), 'BV1hW4y1Y7dG');
        assert.equal(matchSingRequest('翻唱一首 BV1hW4y1Y7dG'), 'BV1hW4y1Y7dG');
        assert.equal(matchSingRequest('给我唱：BV1hW4y1Y7dG 吧'), 'BV1hW4y1Y7dG');
    });

    test('直接贴链接也认', () => {
        assert.equal(matchSingRequest('https://www.bilibili.com/video/BV1hW4y1Y7dG/?x=1'), 'BV1hW4y1Y7dG');
    });

    test('普通聊天不误触', () => {
        assert.equal(matchSingRequest('今天好累'), undefined);
        assert.equal(matchSingRequest('唱歌好听'), undefined);
        assert.equal(matchSingRequest('BV1hW4y1Y7dG'), undefined);
        assert.equal(matchSingRequest('唱吧'), undefined);
    });
});
