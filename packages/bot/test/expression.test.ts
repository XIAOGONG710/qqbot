import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CORRECT_CHANCE, describeLength, LONG_CHANCE, LONG_MIN_CHARS, lengthHint, maybeTypo, SHORT_CHANCE, TYPO_CHANCE, TYPOS } from '../src/expression.ts';

const said = (i: number) => [{ role: 'user' as const, content: `第 ${i} 句，今天上班被老板说了一顿`, time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];

describe('表达层（ADR 0024）', () => {
    test(`长短：约 ${SHORT_CHANCE * 100}% 的轮次回句短的、约 ${LONG_CHANCE * 100}% 话多一点；同一句每次一样`, () => {
        const hints = Array.from({ length: 2000 }, (_, i) => lengthHint({ history: said(i) }));
        const short = hints.filter(h => h === 'short').length / hints.length;
        const long = hints.filter(h => h === 'long').length / hints.length;
        assert.ok(Math.abs(short - SHORT_CHANCE) < 0.03, `short ${short}`);
        assert.ok(Math.abs(long - LONG_CHANCE) < 0.03, `long ${long}`);
        assert.equal(lengthHint({ history: said(7) }), lengthHint({ history: said(7) }));
    });

    test('收尾、主动找他时不加；心情安静、身体不舒服时不加「话多」；他还没说话不加', () => {
        const longOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ history: said(i) }) === 'long')!;
        const shortOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ history: said(i) }) === 'short')!;
        assert.equal(lengthHint({ history: said(longOne), intent: '[这一轮你想：顺着他的话收尾，只回一两句]' }), undefined);
        assert.equal(lengthHint({ history: said(shortOne), initiating: true }), undefined);
        assert.equal(lengthHint({ history: said(longOne), low: true }), undefined);
        assert.equal(lengthHint({ history: said(shortOne), low: true }), 'short', '安静的日子照样可以回句短的');
        assert.equal(lengthHint({ history: [] }), undefined);
        // 他这次说得太短（「到家了」）不加话多；回句短的照样可以
        const brief = (i: number) => [{ role: 'user' as const, content: '到家了', time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
        const hints = Array.from({ length: 500 }, (_, i) => lengthHint({ history: brief(i) }));
        assert.ok(!hints.includes('long'), `不到 ${LONG_MIN_CHARS} 个字不加话多`);
        assert.ok(hints.includes('short'));
        // 他明着让她讲：每次都是话多一点，不抽签；收尾、主动、身上不舒服照旧
        const explain = (i: number) => [{ role: 'user' as const, content: '你帮我认真讲讲，梯度下降到底是怎么回事', time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
        assert.ok(Array.from({ length: 200 }, (_, i) => lengthHint({ history: explain(i) })).every(hint => hint === 'long'));
        assert.ok(Array.from({ length: 50 }, (_, i) => lengthHint({ history: explain(i), low: true })).every(hint => hint !== 'long'), '身上不舒服、心情安静时不加话多');
        assert.equal(lengthHint({ history: explain(1), initiating: true }), undefined);
    });

    test('提示词只给一句约束，不给台词', () => {
        assert.equal(describeLength('short'), '[这一轮说话：只回一句短的，几个字也行；不展开，不另起话题]');
        assert.match(describeLength('long'), /^\[这一轮说话：话多一点/);
    });

    test('打错字：有能打错的词时按概率打错一个，多数跟一条「*正确的词」改口；没有能打错的词就原样', () => {
        const parts = ['我应该明天去', '你早点睡'];
        const results = Array.from({ length: 4000 }, (_, i) => maybeTypo(parts, `seed ${i}`));
        const typed = results.filter(r => r.note);
        const rate = typed.length / results.length;
        assert.ok(Math.abs(rate - TYPO_CHANCE) < 0.03, `typo rate ${rate}`);
        const corrected = typed.filter(r => r.parts.length === 3);
        assert.ok(Math.abs(corrected.length / typed.length - CORRECT_CHANCE) < 0.05);
        assert.deepEqual(corrected[0]!.parts, ['我因该明天去', '*应该', '你早点睡']);
        assert.equal(corrected[0]!.note, '应该 → 因该（改口）');
        const lazy = typed.find(r => r.parts.length === 2)!;
        assert.deepEqual(lazy.parts, ['我因该明天去', '你早点睡']);
        assert.equal(lazy.note, '应该 → 因该（没改）');
        assert.ok(results.filter(r => !r.note).every(r => r.parts.join() === parts.join()));
        assert.deepEqual(maybeTypo(['在呢', '刚洗完澡'], 'seed 1'), { parts: ['在呢', '刚洗完澡'] });
        // 这一轮只能发一条（上课）：打错了也不改口
        const seed = Array.from({ length: 4000 }, (_, i) => `seed ${i}`).find(s => maybeTypo(parts, s).parts.length === 3)!;
        assert.deepEqual(maybeTypo(['我应该明天去'], seed, 1), { parts: ['我因该明天去'], note: '应该 → 因该（没改）' });
    });

    test('错词表：打错的和正确的读音一样、不是同一个词', () => {
        for (const [right, wrong] of TYPOS) {
            assert.notEqual(right, wrong);
            assert.equal(right.length, wrong.length, `${right} / ${wrong}`);
        }
    });
});
