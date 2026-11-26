import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    edgesOf, finalChar, hasTail, measureEdges, perThousandChars, share, tailParticle, TAIL_PARTICLES,
} from '../src/language/rough-edges.ts';

describe('毛刺度量（rough-edges，ADR 0146 实验 C）', () => {
    test('语气字表：吗不算疑问以外的尾巴', () => {
        assert.equal(TAIL_PARTICLES, '吧啊呢嘛哦呀啦');
        assert.equal(TAIL_PARTICLES.includes('吗'), false);
        assert.equal(TAIL_PARTICLES.includes('啊'), true);
    });

    test('finalChar：先去表情记号、再去尾部标点/拖音，取最后一个字', () => {
        assert.equal(finalChar('好啊'), '啊');
        assert.equal(finalChar('好啊！'), '啊');
        assert.equal(finalChar('好啊[笑]！'), '啊');
        assert.equal(finalChar(''), '');
        assert.equal(finalChar('...'), '');
        // 表情记号最多 6 个字，超出就不匹配，末尾是 ']'
        assert.equal(finalChar('[表情很长很长很长]'), ']');
        // 一个 emoji 是一个码点
        assert.equal(finalChar('哈😀'), '😀');
    });

    test('hasTail / tailParticle：句尾挂语气字算，单字应声和「吗」不算', () => {
        assert.equal(hasTail('好啊'), true);
        assert.equal(hasTail('好啊！'), true);
        assert.equal(tailParticle('好啊'), '啊');
        assert.equal(tailParticle('好哦。'), '哦');

        assert.equal(hasTail('啊'), false);
        assert.equal(hasTail('好吗'), false);
        assert.equal(hasTail('[笑]啊'), false);
        assert.equal(hasTail(''), false);
        assert.equal(tailParticle('啊'), undefined);
        assert.equal(tailParticle('好吗'), undefined);

        assert.equal(hasTail('好啊[捂脸][捂脸]'), true);
        assert.equal(tailParticle('好啊[捂脸][捂脸]'), '啊');
    });

    test('edgesOf 命中：嗯/那个、省略号、笑、语气字各算一类', () => {
        assert.deepEqual(edgesOf('嗯，你好'), { tail: false, hesitation: true, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('那个……我'), { tail: false, hesitation: true, ellipsis: true, laugh: false });
        assert.deepEqual(edgesOf('好哦。'), { tail: true, hesitation: false, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('哈哈'), { tail: false, hesitation: false, ellipsis: false, laugh: true });
        assert.deepEqual(edgesOf('hhh'), { tail: false, hesitation: false, ellipsis: false, laugh: true });
        assert.deepEqual(edgesOf('233'), { tail: false, hesitation: false, ellipsis: false, laugh: true });
    });

    test('edgesOf 中英混排：emm 按英文读、语气字按中文读', () => {
        assert.deepEqual(edgesOf('emm, 好的吧'), { tail: true, hesitation: true, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('嗯嗯 ok 吧'), { tail: true, hesitation: true, ellipsis: false, laugh: false });
    });

    test('edgesOf 不命中：普通文本、空串、表情记号里的笑不算', () => {
        assert.deepEqual(edgesOf('你好'), { tail: false, hesitation: false, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf(''), { tail: false, hesitation: false, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('[哈哈]你好'), { tail: false, hesitation: false, ellipsis: false, laugh: false });
    });

    test('edgesOf 多行：换行本身可作为停顿的分界', () => {
        assert.deepEqual(edgesOf('第一行\n嗯，第二行'), { tail: false, hesitation: true, ellipsis: false, laugh: false });
        assert.deepEqual(edgesOf('好啊\n哈哈'), { tail: false, hesitation: false, ellipsis: false, laugh: true });
    });

    test('measureEdges：逐条计数，空气泡跳过，一条最多算一次', () => {
        assert.deepEqual(measureEdges([]), { bubbles: 0, chars: 0, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 });
        assert.deepEqual(measureEdges(['', '   ', '\n']), { bubbles: 0, chars: 0, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 });
        assert.deepEqual(measureEdges(['好啊', '嗯，来啦', '哈哈', '普通']), {
            bubbles: 4, chars: 10, tail: 2, hesitation: 1, ellipsis: 0, laugh: 1, any: 3,
        });
    });

    test('measureEdges：表情不计字符，emoji 按一个码点计', () => {
        assert.deepEqual(measureEdges(['[笑]哈哈']), { bubbles: 1, chars: 2, tail: 0, hesitation: 0, ellipsis: 0, laugh: 1, any: 1 });
        assert.deepEqual(measureEdges(['  好啊  ']), { bubbles: 1, chars: 2, tail: 1, hesitation: 0, ellipsis: 0, laugh: 0, any: 1 });
        assert.deepEqual(measureEdges(['哈😀']), { bubbles: 1, chars: 2, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 });
        // 去掉表情后为空：仍有气泡，但字符数为 0
        assert.deepEqual(measureEdges(['[笑]']), { bubbles: 1, chars: 0, tail: 0, hesitation: 0, ellipsis: 0, laugh: 0, any: 0 });
    });

    test('share 与 perThousandChars：按条数/按千字，空分母返回 0', () => {
        const stats = measureEdges(['好啊', '嗯，来啦', '哈哈', '普通']);
        assert.equal(share(stats, 'tail'), 0.5);
        assert.equal(share(stats, 'any'), 0.75);
        assert.equal(share(stats, 'ellipsis'), 0);
        assert.equal(perThousandChars(stats, 'tail'), 200);
        assert.equal(perThousandChars(stats, 'laugh'), 100);
        assert.equal(perThousandChars(stats, 'any'), 300);

        const empty = measureEdges([]);
        assert.equal(share(empty, 'any'), 0);
        assert.equal(perThousandChars(empty, 'any'), 0);
        assert.equal(perThousandChars(measureEdges(['[笑]']), 'any'), 0);
    });
});
