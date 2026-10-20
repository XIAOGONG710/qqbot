import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BURST_CHANCE, CARE_INTENT, CORRECT_CHANCE, describeLength, ENGAGED_INTENT, LEGACY_SHORT_CHANCE, LONG_CHANCE, LONG_MIN_CHARS, lengthHint, maybeTypo, RECALL_SHARE, SHORT_CHANCE, TYPO_CHANCE, TYPOS, WORRIED_TEXT } from '../src/expression.ts';

const said = (i: number) => [{ role: 'user' as const, content: `第 ${i} 句，今天上班被老板说了一顿`, time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];

describe('表达层（ADR 0024）', () => {
    test(`长短：约 ${SHORT_CHANCE * 100}% 的轮次回句短的、约 ${LONG_CHANCE * 100}% 话多一点；同一句每次一样`, () => {
        const hints = Array.from({ length: 2000 }, (_, i) => lengthHint({ shortReplies: true, history: said(i) }));
        const short = hints.filter(h => h === 'short').length / hints.length;
        const long = hints.filter(h => h === 'long').length / hints.length;
        assert.ok(Math.abs(short - SHORT_CHANCE) < 0.03, `short ${short}`);
        assert.ok(Math.abs(long - LONG_CHANCE) < 0.03, `long ${long}`);
        assert.equal(lengthHint({ shortReplies: true, history: said(7) }), lengthHint({ shortReplies: true, history: said(7) }));
    });

    test('他在难受、报好事、说自己的事、要亲近 / 要哄的轮次（意图行）不加「回很短」，普通问答照常抽', () => {
        const shortOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ shortReplies: true, history: said(i) }) === 'short')!;
        for (const intent of [
            '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]',
            '[这一轮你想：他刚说了件好事，先替他高兴、接住这件事]',
            '[这一轮你想：回应他刚说的那件事；真有想知道的细节再随口问]',
            '[这一轮你想：只接他刚说的你们两个人的事，一两句就够]',
            '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]',
            '[这一轮你想：他在撒娇要你哄他、陪他，只接他刚说的你们两个人的事]',
        ]) {
            assert.ok(ENGAGED_INTENT.test(intent), intent);
            assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), intent }), undefined, intent);
        }
        assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' }), 'short');
    });

    test('他问起她认识的人（「雨桐最近怎么样」）：不加「回很短」，别的话题照常抽', () => {
        const shortOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ shortReplies: true, history: said(i) }) === 'short')!;
        assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), aboutPerson: true }), undefined);
        assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), aboutPerson: false }), 'short');
    });

    test('他刚在说不顺心 / 担心的事（报告被打回、没过、怎么办、还有救吗）：意图行只是「先直接回答他刚问的」也不加「回很短」；普通玩笑里的词不收', () => {
        const asked = '[这一轮你想：先直接回答他刚问的，不另起话题]';
        const history = (lines: string[], i: number) => lines.map((content, k) => ({ role: 'user' as const, content, time: new Date(Date.UTC(2026, 9, 7, 12, 0, i, k)).toISOString() }));
        for (const worried of [['我实训报告被老师打回来了', '让我重写', '你说我这还有救吗'], ['这次考试可能没过', '怎么办'], ['我是不是不行啊'], ['又挂科了咋办']]) {
            assert.ok(WORRIED_TEXT.test(worried.join('')), worried.join('/'));
            for (let i = 0; i < 200; i++) assert.notEqual(lengthHint({ shortReplies: true, history: history(worried, i), intent: asked }), 'short', worried.join('/'));
        }
        for (const joking of ['你服了没', '烦人精', '你太逗了', '今天吃什么']) assert.ok(!WORRIED_TEXT.test(joking), joking);
        // 普通问答照常抽到「很短」
        assert.ok(Array.from({ length: 400 }, (_, i) => lengthHint({ shortReplies: true, history: history(['今天吃什么'], i), intent: asked })).includes('short'));
    });

    test('收尾、主动找他时不加；心情安静、身体不舒服时不加「话多」；他还没说话不加', () => {
        const longOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ shortReplies: true, history: said(i) }) === 'long')!;
        const shortOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ shortReplies: true, history: said(i) }) === 'short')!;
        assert.equal(lengthHint({ shortReplies: true, history: said(longOne), intent: '[这一轮你想：顺着他的话收尾，只回一两句]' }), undefined);
        assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), initiating: true }), undefined);
        assert.equal(lengthHint({ shortReplies: true, history: said(longOne), low: true }), undefined);
        assert.equal(lengthHint({ shortReplies: true, history: said(shortOne), low: true }), 'short', '安静的日子照样可以回句短的');
        assert.equal(lengthHint({ shortReplies: true, history: [] }), undefined);
        // 他这次说得太短（「到家了」）不加话多；回句短的照样可以
        const brief = (i: number) => [{ role: 'user' as const, content: '到家了', time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
        const hints = Array.from({ length: 500 }, (_, i) => lengthHint({ shortReplies: true, history: brief(i) }));
        assert.ok(!hints.includes('long'), `不到 ${LONG_MIN_CHARS} 个字不加话多`);
        assert.ok(hints.includes('short'));
        // 他明着让她讲：每次都是话多一点，不抽签；收尾、主动、身上不舒服照旧
        const explain = (i: number) => [{ role: 'user' as const, content: '你帮我认真讲讲，梯度下降到底是怎么回事', time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
        assert.ok(Array.from({ length: 200 }, (_, i) => lengthHint({ shortReplies: true, history: explain(i) })).every(hint => hint === 'long'));
        assert.ok(Array.from({ length: 50 }, (_, i) => lengthHint({ shortReplies: true, history: explain(i), low: true })).every(hint => hint !== 'long'), '身上不舒服、心情安静时不加话多');
        assert.equal(lengthHint({ shortReplies: true, history: explain(1), initiating: true }), undefined);
    });

    test('提示词只给一句约束，不给台词', () => {
        assert.match(describeLength('short', true), /^\[这一轮说话：只回很短的一句，一两个字也行/);
        assert.match(describeLength('short', true), /他在难受、报大事、等安慰或闹别扭时不适用，照平常的说/);
        assert.match(describeLength('long'), /^\[这一轮说话：话多一点/);
    });

    test(`没开 shortReplies（上线前的老样子）：约 ${LEGACY_SHORT_CHANCE * 100}% 回句短的，认真接话的轮次、说担心的事、问起朋友的轮次不让路，措辞是老的；开关只改这三处`, () => {
        const legacy = Array.from({ length: 4000 }, (_, i) => lengthHint({ history: said(i) }));
        const short = legacy.filter(h => h === 'short').length / legacy.length;
        assert.ok(Math.abs(short - LEGACY_SHORT_CHANCE) < 0.02, `short ${short}`);
        assert.equal(describeLength('short'), '[这一轮说话：只回一句短的，几个字也行；不展开，不另起话题]');
        assert.equal(describeLength('short', false), describeLength('short'));
        // 老样子里让路的规则不生效：抽到的轮次，不管意图行、他说的话、是不是问起朋友，都是「短」
        const shortOne = Array.from({ length: 200 }, (_, i) => i).find(i => lengthHint({ history: said(i) }) === 'short')!;
        assert.equal(lengthHint({ history: said(shortOne), intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' }), 'short');
        assert.equal(lengthHint({ history: said(shortOne), aboutPerson: true }), 'short');
        // 打开之后，同一句话的抽签结果：老样子里是「短」的，开了之后仍是「短」或被让路（0.35 < 0.5，老的短一定在新的范围里）
        for (let i = 0; i < 300; i++) if (lengthHint({ history: said(i) }) === 'short') assert.ok(['short', undefined].includes(lengthHint({ shortReplies: true, history: said(i) })));
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

    test('撤回重发（ADR 0086）：有撤回的本事时，改口的一部分不再多出一条「*对的词」，而是先发打错的、撤回、再发对的；没有这个本事时和以前完全一样；上课只回一条时也能用', () => {
        const parts = ['我应该明天去', '你早点睡'];
        const seeds = Array.from({ length: 4000 }, (_, i) => `seed ${i}`);
        for (const seed of seeds) assert.deepEqual(maybeTypo(parts, seed, 3, 0), maybeTypo(parts, seed, 3), '不给 recallShare 和以前一样');
        const results = seeds.map(seed => maybeTypo(parts, seed, 3, RECALL_SHARE));
        const corrected = results.filter(r => r.note?.includes('改口') || r.note?.includes('撤回重发'));
        const recalled = results.filter(r => r.recall);
        assert.ok(Math.abs(recalled.length / corrected.length - RECALL_SHARE) < 0.07, `${recalled.length}/${corrected.length}`);
        const one = recalled[0]!;
        assert.deepEqual(one.parts, parts, '发出去的最终内容是对的那版，没有多出一条');
        assert.deepEqual(one.recall, { index: 0, wrong: '我因该明天去', fix: '*应该', afterMs: one.recall!.afterMs });
        assert.equal(one.note, '应该 → 因该（撤回重发）');
        assert.ok(recalled.every(r => r.recall!.afterMs >= 1500 && r.recall!.afterMs < 5000));
        // 其余的（改口、没改、没打错）和不给 recallShare 时完全一样
        for (const [i, r] of results.entries()) if (!r.recall) assert.deepEqual(r, maybeTypo(parts, seeds[i]!, 3));
        // 只能发一条（上课）：没法多出一条改口，但撤回重发不多出条数，可以用
        const seed = seeds.find(s => maybeTypo(parts, s, 1, RECALL_SHARE).recall)!;
        assert.deepEqual(maybeTypo(['我应该明天去'], seed, 1, RECALL_SHARE).parts, ['我应该明天去']);
    });

    test('错词表：打错的和正确的读音一样、不是同一个词', () => {
        for (const [right, wrong] of TYPOS) {
            assert.notEqual(right, wrong);
            assert.equal(right.length, wrong.length, `${right} / ${wrong}`);
        }
    });

    test(`想到哪说到哪（burst，候选 6）：要 shortReplies 和 burst 两个都开；约 ${BURST_CHANCE * 100}% 的轮次连发几条很短的；几种情形不用`, () => {
        const on = { shortReplies: true, burst: true };
        const hints = Array.from({ length: 3000 }, (_, i) => lengthHint({ history: said(i), ...on }));
        const burst = hints.filter(h => h === 'burst').length / hints.length;
        assert.ok(Math.abs(burst - BURST_CHANCE) < 0.03, `burst ${burst}`);
        // 没开开关就绝不出现这一档：只开 shortReplies、只开 burst、都不开
        for (const off of [{ shortReplies: true }, { burst: true }, {}]) {
            for (let i = 0; i < 600; i++) assert.notEqual(lengthHint({ history: said(i), ...off }), 'burst', JSON.stringify(off));
        }
        // 开了 burst 不改变 short / long 的抽签：同一条消息，没有 burst 时是 short / long 的，开了之后还是
        for (let i = 0; i < 600; i++) {
            const before = lengthHint({ history: said(i), shortReplies: true });
            const after = lengthHint({ history: said(i), ...on });
            if (before !== undefined) assert.equal(after, before, `第 ${i} 句`);
        }
        const one = Array.from({ length: 400 }, (_, i) => i).find(i => lengthHint({ history: said(i), ...on }) === 'burst')!;
        assert.ok(one !== undefined, '有触发 burst 的句子');
        assert.ok(describeLength('burst').includes('连着发三四条很短的') && describeLength('burst').includes('不报自己今天的别的事') && describeLength('burst').includes('最多最后一条带一个简短的问句'));
        // 他说的太短（「到家了」）、她心情安静 / 不舒服：不用
        const shortSaid = [{ role: 'user' as const, content: '到家了', time: said(one)[0]!.time }];
        assert.notEqual(lengthHint({ history: shortSaid, ...on }), 'burst');
        assert.notEqual(lengthHint({ history: said(one), low: true, ...on }), 'burst');
        // 要先接住他情绪：不用；收尾、主动找他：不用；问起她认识的人：不用
        const care = '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]';
        assert.ok(CARE_INTENT.test(care));
        assert.notEqual(lengthHint({ history: said(one), intent: care, ...on }), 'burst');
        assert.equal(lengthHint({ history: said(one), intent: '[这一轮你想：顺着他的话收尾]', ...on }), undefined);
        assert.equal(lengthHint({ history: said(one), initiating: true, ...on }), undefined);
        assert.notEqual(lengthHint({ history: said(one), aboutPerson: true, ...on }), 'burst');
        // 他刚在说不顺心的事：不用
        const worried = (i: number) => [{ role: 'user' as const, content: '我实训报告被老师打回来了，你说我这还有救吗', time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
        for (let i = 0; i < 300; i++) assert.notEqual(lengthHint({ history: worried(i), ...on }), 'burst');
    });

    test('固定抽签结果 roll（只给模拟器 / 盲评生成器）：0.6 恰好落在 burst 区间开头；让路的规则照常生效；不传就还是哈希', () => {
        const on = { shortReplies: true, burst: true };
        const text = [{ role: 'user' as const, content: '今天去食堂吃了新开的那家面，味道还可以', time: '2026-10-07T12:00:00.000Z' }];
        assert.equal(lengthHint({ history: text, roll: 0.6, ...on }), 'burst');
        assert.equal(lengthHint({ history: text, roll: 0.6, shortReplies: true }), undefined, 'burst 关着：同样的抽签不出现这一档');
        assert.equal(lengthHint({ history: text, roll: 0.3, ...on }), 'short');
        assert.equal(lengthHint({ history: text, roll: 0.55, ...on }), 'long');
        assert.equal(lengthHint({ history: text, roll: 0.99, ...on }), undefined);
        const worried = [{ role: 'user' as const, content: '我实训报告被老师打回来了，你说我这还有救吗', time: '2026-10-07T12:00:00.000Z' }];
        assert.notEqual(lengthHint({ history: worried, roll: 0.6, ...on }), 'burst', '他在说不顺心的事：固定了抽签也让路');
        assert.notEqual(lengthHint({ history: text, roll: 0.6, aboutPerson: true, ...on }), 'burst');
        assert.equal(lengthHint({ history: text, ...on }), lengthHint({ history: text, ...on, roll: undefined }), '不传 roll 就是哈希');
    });
});
