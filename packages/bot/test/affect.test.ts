import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AFFECT_REPLIES, describeWarmAffect, warmAffect } from '../src/emotion/affect.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { describeUnsettled, type OpenLoop } from '../src/life/open-loops.ts';

const message = (role: StoredMessage['role'], content: string): StoredMessage => ({ role, content, time: '2026-10-07T12:00:00.000Z' });

describe('短期情绪惯性（ADR 0028）', () => {
    test('明确的安慰、道歉和想念留下三轮余温；连续气泡只算一轮', () => {
        assert.equal(AFFECT_REPLIES, 3);
        assert.deepEqual(warmAffect([message('user', '抱抱，早点睡，我在呢')]), { kind: 'comfort', replies: 0, remaining: 3 });
        assert.deepEqual(warmAffect([
            message('user', '对不起，是我不好'),
            message('assistant', '行吧'), message('assistant', '下次别这样'),
            message('user', '嗯'),
        ]), { kind: 'repair', replies: 1, remaining: 2 });
        assert.deepEqual(warmAffect([message('user', '我想你了')]), { kind: 'affection', replies: 0, remaining: 3 });
    });

    test('三轮后消退；普通短句不脑补成态度', () => {
        assert.equal(warmAffect([
            message('user', '抱歉'),
            message('assistant', '一'), message('user', '嗯'),
            message('assistant', '二'), message('user', '哦'),
            message('assistant', '三'), message('user', '行'),
        ]), undefined);
        assert.equal(warmAffect([message('user', '嗯'), message('user', '哦'), message('user', '行')]), undefined);
    });

    test('提示词只要求自然变软，不让她解释状态或突然煽情', () => {
        const text = describeWarmAffect({ kind: 'repair', replies: 0, remaining: 3 })!;
        assert.match(text, /认真道歉、修补/);
        assert.match(text, /自然比刚才软一点/);
        assert.match(text, /不用解释自己的状态，也不用郑重道谢或突然煽情/);
        const loop: OpenLoop = { id: 'x', kind: 'unsettled', what: '说好一起看电影，最后没看成', said: '2026-10-06', episode: 'e' };
        assert.match(describeUnsettled([loop], true)!, /他刚刚正在修补，所以别机械地继续绷着；先接住当下的好意/);
        assert.doesNotMatch(describeUnsettled([loop], true)!, /委屈|难过|生气/);
    });
});
