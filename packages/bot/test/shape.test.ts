import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeShape, PLAIN_SHARE, planShape, shapeProblems, shapeReply, trimToShape, type ShapePlan } from '../src/shape.ts';

/** 同一句话，靠时间区分每一次抽签（抽签的种子是时间加内容），字数不变 */
const said = (i: number, text: string) => [{ role: 'user' as const, content: text, time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }];
const sample = (text: string, n = 800, extra: Partial<Parameters<typeof planShape>[0]> = {}) => Array.from({ length: n }, (_, i) => planShape({ history: said(i, text), ...extra })!);
const share = (plans: ShapePlan[], kind: ShapePlan['kind']) => plans.filter(plan => plan.kind === kind).length / plans.length;

describe('形状控制：这一轮每条最多几个字、最多几条（ADR 0091）', () => {
    test('同一句话每次一样；不适用的轮次没有形状：主动找他、他明着让她讲、他还没说话', () => {
        assert.deepEqual(planShape({ history: said(3, '今天好累') }), planShape({ history: said(3, '今天好累') }));
        assert.equal(planShape({ history: said(3, '今天好累'), initiating: true }), undefined);
        assert.equal(planShape({ history: said(3, '你帮我认真讲讲这个') }), undefined);
        assert.equal(planShape({ history: [] }), undefined);
    });

    test('收尾的轮次（「顺着他的话收尾」）用最短的两档为主、最多两条；亲近那条意图行里的「收尾」两个字不算收尾', () => {
        const closing = sample('晚安啦我先睡了', 600, { intent: '[这一轮你想：顺着他的话收尾，只回一两句；不分享新进度]' });
        assert.ok(share(closing, 'micro') + share(closing, 'short') > 0.7);
        assert.ok(closing.every(plan => plan.maxBubbles <= 2) && closing.every(plan => plan.cap <= 24));
        const close = sample('想你了', 400, { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事：先给一个明确的亲密回应……他真要收尾时回应后顺着收尾，他不想你走时能陪就多陪一句]' });
        assert.equal(share(close, 'micro'), 0, '这是亲近的轮次，不是收尾');
        assert.ok(share(close, 'medium') > 0.3);
    });

    test('字数档取自真人的分布：他说得不长时，约四分之一是 4 字以内、过半 8 字以内、八成 14 字以内；每条上限只有这五档', () => {
        const plans = sample('在干嘛啊你');
        const micro = share(plans, 'micro');
        const upTo8 = micro + share(plans, 'short');
        const upTo14 = upTo8 + share(plans, 'medium');
        assert.ok(Math.abs(micro - 0.25) < 0.06, `micro ${micro}`);
        assert.ok(Math.abs(upTo8 - 0.55) < 0.06, `≤8 ${upTo8}`);
        assert.ok(Math.abs(upTo14 - 0.82) < 0.06, `≤14 ${upTo14}`);
        assert.deepEqual([...new Set(plans.map(plan => plan.cap))].sort((a, b) => a - b), [4, 8, 14, 24, 40]);
    });

    test('跟着他的长短走：他只发两三个字，她多半也只回几个字；他发一大段，她的上限放宽', () => {
        const tiny = sample('嗯');
        const big = sample('今天下午我们去了图书馆然后发现没位置就去食堂坐了一会儿后来又回宿舍了你说烦不烦啊真的是');
        assert.ok(share(tiny, 'micro') + share(tiny, 'short') > 0.65);
        assert.ok(share(big, 'micro') + share(big, 'short') < 0.3);
        assert.ok(share(big, 'long') + share(big, 'wide') > 0.4);
    });

    test('他在难受、报大事、问起她认识的人、被打回的轮次：只用长的几档，不会只回两个字', () => {
        for (const extra of [
            { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' },
            { intent: '[这一轮你想：他刚说了件好事，替他高兴]' },
            { aboutPerson: true },
        ]) {
            assert.ok(sample('嗯', 300, extra).every(plan => plan.cap >= 14), JSON.stringify(extra));
        }
        const worried = Array.from({ length: 300 }, (_, i) => planShape({ history: [{ role: 'user' as const, content: `报告被老师打回来了${i}`, time: new Date(Date.UTC(2026, 9, 7, 12, 0, i)).toISOString() }] })!);
        assert.ok(worried.every(plan => plan.cap >= 14));
    });

    test('最常见的意图行「回应他刚说的那件事」照常抽（不再整轮排除在短回复之外）；亲近 / 撒娇的轮次有短的、没有极短的', () => {
        const respond = sample('在干嘛啊你', 800, { intent: '[这一轮你想：回应他刚说的那件事；真有想知道的细节再随口问]' });
        assert.ok(share(respond, 'micro') > 0.15 && share(respond, 'micro') + share(respond, 'short') > 0.45);
        const close = sample('想你了', 600, { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' });
        assert.equal(share(close, 'micro'), 0);
        assert.ok(share(close, 'short') > 0.25);
    });

    test('心情安静、身体不舒服：往短里挪，不用最长的两档的比例变小', () => {
        const normal = sample('今天怎么样啊你');
        const low = sample('今天怎么样啊你', 800, { low: true });
        assert.ok(share(low, 'micro') > share(normal, 'micro'));
        assert.ok(share(low, 'wide') + share(low, 'long') < share(normal, 'wide') + share(normal, 'long'));
    });

    test('一轮几条：极短的一档多半一条；其余 1 条过半、2 条约四分之一、3 条约六分之一', () => {
        const plans = sample('在干嘛啊你', 1500);
        const micro = plans.filter(plan => plan.kind === 'micro');
        const rest = plans.filter(plan => plan.kind !== 'micro');
        assert.ok(micro.filter(plan => plan.maxBubbles === 1).length / micro.length > 0.7);
        const count = (n: number) => rest.filter(plan => plan.maxBubbles === n).length / rest.length;
        assert.ok(Math.abs(count(1) - 0.55) < 0.07 && Math.abs(count(2) - 0.28) < 0.07 && Math.abs(count(3) - 0.17) < 0.07, `${count(1)} ${count(2)} ${count(3)}`);
    });

    test('约七成的轮次“顺着他说”（不驳他、不损他、不嘴硬）；亲近 / 撒娇的轮次不加（那条意图行里本来就有一点嘴硬）', () => {
        const plans = sample('在干嘛啊你', 1000);
        const plain = plans.filter(plan => plan.plain).length / plans.length;
        assert.ok(Math.abs(plain - PLAIN_SHARE) < 0.05, `plain ${plain}`);
        const close = sample('想你了', 300, { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' });
        assert.ok(close.every(plan => !plan.plain));
        const on = describeShape({ kind: 'short', cap: 8, maxBubbles: 1, plain: true });
        assert.ok(on.includes('顺着他说就行') && on.includes('别反驳他、别损他、别嘴硬') && on.includes('别用反问句回他') && on.endsWith(']'), on);
        assert.ok(!describeShape({ kind: 'micro', cap: 4, maxBubbles: 1 }).includes('反问'), '极短的一档不再鼓励反问');
        assert.ok(!describeShape({ kind: 'short', cap: 8, maxBubbles: 1 }).includes('顺着他说'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, plain: true }).includes('顺着他说就行'));
        assert.ok(!/[「“"]/.test(on), '不举例句');
    });

    test('提示词里的一行：给数字和方向，不给台词', () => {
        for (const kind of ['micro', 'short', 'medium', 'long', 'wide'] as const) {
            const cap = { micro: 4, short: 8, medium: 14, long: 24, wide: 40 }[kind];
            const line = describeShape({ kind, cap, maxBubbles: 2 });
            assert.ok(line.startsWith('[这一轮说话：') && line.endsWith(']'), line);
            assert.ok(line.includes(`不超过 ${cap} 个字`) && line.includes('2 条'), line);
        }
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1 }).includes('只回一条'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1 }).includes('他在难受、报大事、等安慰或闹别扭时不适用'));
        assert.ok(!/[「“"]/.test(describeShape({ kind: 'short', cap: 8, maxBubbles: 1 })), '不举例句');
    });
});

describe('形状控制：强制执行', () => {
    const plan: ShapePlan = { kind: 'short', cap: 8, maxBubbles: 2 };

    test('合格的原样放行（超一点不算：8 字的上限放到 11 字）', () => {
        assert.deepEqual(shapeProblems('好的呀\n我也是这样觉得的呢', plan), { tooLong: 0, tooMany: 0 });
        assert.deepEqual(shapeProblems('一二三四五六七八九十一', plan), { tooLong: 0, tooMany: 0 });
        assert.deepEqual(shapeProblems('一二三四五六七八九十一二', plan), { tooLong: 1, tooMany: 0 });
        assert.deepEqual(shapeProblems('一\n二\n三', plan), { tooLong: 0, tooMany: 1 });
    });

    test('截断：只在分句处截，多出的条数去掉；找不到分句处就原样留着；图片表情的行不算', () => {
        const long = '今天真的好累啊，而且还要写作业，烦死了';
        assert.deepEqual(trimToShape(long, plan), { reply: '今天真的好累啊', notes: ['一条 19 字的截到 7 字'] });
        assert.equal(trimToShape('一二三四五六\n七八九十\n十一十二', plan).reply, '一二三四五六\n七八九十');
        const noBreak = '今天真的好累啊而且还要写作业烦死了';
        assert.deepEqual(trimToShape(noBreak, plan), { reply: noBreak, notes: ['一条 17 字的找不到分句处，原样留着'] });
        assert.equal(trimToShape('<sticker:0123456789ab>\n好的', plan).reply, '<sticker:0123456789ab>\n好的');
        assert.equal(trimToShape('一二三\n四五六\n七八九\n<sticker:0123456789ab>', plan).reply, '一二三\n四五六\n<sticker:0123456789ab>', '表情指令不占条数名额');
        assert.deepEqual(shapeProblems('好的\n<sticker:0123456789ab>\n嗯嗯', plan), { tooLong: 0, tooMany: 0 });
        const micro: ShapePlan = { kind: 'micro', cap: 4, maxBubbles: 1 };
        assert.equal(trimToShape('好啊，那就明天再说吧', micro).reply, '好啊');
    });

    test('出口：合格的不重写；太长重写一次，重写的合格就用重写的；重写还长就截；重写失败也截', async () => {
        const logs: string[] = [];
        const notes: string[] = [];
        const make = (reply: string | Error) => ({ regenerate: async (note: string) => { notes.push(note); if (reply instanceof Error) throw reply; return reply; }, log: (m: string) => logs.push(m) });
        assert.equal(await shapeReply('好的呀', plan, make('不该到这里')), '好的呀');
        assert.equal(notes.length, 0);

        const tooLong = '今天真的好累啊，而且还要写作业，烦死了';
        assert.equal(await shapeReply(tooLong, plan, make('好累啊')), '好累啊');
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.includes('每条不超过 8 个字，最多 2 条') && notes[0]!.startsWith('[上一版回复没有发出去'), notes[0]);
        assert.ok(!notes[0]!.includes('烦死了'), '说明里不带上一版的原话');

        assert.equal(await shapeReply(tooLong, plan, make('累死了呀，而且还要写作业，真的烦')), '累死了呀');
        assert.equal(await shapeReply(tooLong, plan, make(new Error('429'))), '今天真的好累啊');
        assert.ok(logs.some(line => line.includes('重写失败') && line.includes('429')));
        assert.equal(await shapeReply(tooLong, plan, make('')), '今天真的好累啊', '重写是空的就用第一版截');
    });
});
