import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clip, createNavBudget, BudgetExhausted, memoryOk, MIN_FREE_BYTES, pause, parseCount, parseDuration, riskInText, uniqueById, waitFor } from '../src/social.ts';

describe('小红书 / 抖音共用部分（ADR 0166）', () => {
    test('计数文字：万、亿、w、加号；读不懂返回 undefined', () => {
        assert.equal(parseCount('3611'), 3611);
        assert.equal(parseCount('8万'), 80000);
        assert.equal(parseCount('1.2万'), 12000);
        assert.equal(parseCount('10w+'), 100000);
        assert.equal(parseCount('1.5亿'), 150000000);
        assert.equal(parseCount(42), 42);
        for (const bad of ['', '点赞', '赞', undefined, null, {}, NaN]) assert.equal(parseCount(bad), undefined, String(bad));
    });

    test('时长：分:秒、时:分:秒', () => {
        assert.equal(parseDuration('14:55'), 895);
        assert.equal(parseDuration('1:02:03'), 3723);
        assert.equal(parseDuration('04:06'), 246);
        assert.equal(parseDuration('8.8万'), undefined);
        assert.equal(parseDuration('99'), undefined);
    });

    test('截短：去换行、方括号（会和占位符搞混）、多余空白；按字算（emoji 不被劈开）', () => {
        assert.equal(clip('  第一行\n第二行 [话题]  【置顶】 ', 40), '第一行 第二行 话题 置顶');
        assert.equal(clip('a'.repeat(50), 10), `${'a'.repeat(10)}…`);
        assert.equal(clip('😍'.repeat(5), 3), '😍😍😍…');
        assert.equal(clip(undefined, 10), '');
    });

    test('风控文字：明确的验证 / 限制说法算；登录框里的「验证码」不算', () => {
        assert.equal(riskInText('请完成安全验证'), '安全验证');
        assert.equal(riskInText('您的访问过于频繁'), '访问过于频繁');
        assert.equal(riskInText('当前 IP 存在风险，请切换网络'), 'IP 存在风险');
        assert.equal(riskInText('账号已被限制'), '账号已被限制');
        assert.equal(riskInText('手机号登录 +86 输入验证码 获取验证码 登录后推荐更懂你的笔记'), undefined);
        assert.equal(riskInText('精选 推荐 关注 朋友 我的'), undefined);
    });

    test('内存守卫：低于 900 MB 不开浏览器', () => {
        assert.equal(MIN_FREE_BYTES, 900 * 1024 * 1024);
        assert.equal(memoryOk(899 * 1024 * 1024), false);
        assert.equal(memoryOk(900 * 1024 * 1024), true);
        assert.equal(typeof memoryOk(), 'boolean');
    });

    test('导航预算：用完抛 BudgetExhausted；去重保序；停顿带抖动', async () => {
        const budget = createNavBudget(2);
        budget.take(); budget.take();
        assert.equal(budget.left, 0);
        assert.throws(() => budget.take(), BudgetExhausted);
        assert.deepEqual(uniqueById([{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'a', n: 3 }]).map(x => x.n), [1, 2]);
        const slept: number[] = [];
        await pause({ sleep: async ms => { slept.push(ms); }, random: () => 0.5 }, 2000, 5000);
        await pause({ sleep: async ms => { slept.push(ms); }, random: () => 0 }, 2000, 5000);
        assert.deepEqual(slept, [3500, 2000]);
    });

    test('等一个条件：按次数问，问到就返回；一直没有返回 undefined；probe 抛错当没有', async () => {
        let calls = 0;
        const instant = { sleep: async () => undefined, random: () => 0 };
        assert.equal(await waitFor(instant, async () => (++calls === 3 ? 'ok' : undefined), 5_000, 500), 'ok');
        assert.equal(calls, 3);
        calls = 0;
        assert.equal(await waitFor(instant, async () => { calls++; return undefined; }, 1_000, 500), undefined);
        assert.equal(calls, 3, '1000/500 = 2 次间隔，问 3 次');
        assert.equal(await waitFor(instant, async () => { throw new Error('页面还没好'); }, 500, 500), undefined);
    });
});
