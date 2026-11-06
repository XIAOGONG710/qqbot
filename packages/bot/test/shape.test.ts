import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AGENDA_SHARE, DELIBERATE_NOTE, deliberateTurn, describeShape, invitesLong, LONG_CAP, LONG_SHARE, DRAWL_SHARE, FEEL_SHARE, FILLER_SHARE, STRETCH_SHARE, PLAIN_SHARE, planShape, shapeProblems, shapeReply, trimToShape, type ShapePlan } from '../src/language/shape.ts';

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
        assert.ok(on.includes('顺着他说就行') && on.includes('别反驳他、别损他、别嘴硬') && on.includes('别用反问句回他') && on.includes('网络缩写') && on.endsWith(']'), on);
        assert.ok(!describeShape({ kind: 'micro', cap: 4, maxBubbles: 1 }).includes('反问'), '极短的一档不再鼓励反问');
        assert.ok(!describeShape({ kind: 'short', cap: 8, maxBubbles: 1 }).includes('顺着他说'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, plain: true }).includes('顺着他说就行'));
        assert.ok(!/[「“"]/.test(on), '不举例句');
    });

    // ADR 0094：真人女生一侧 30% 的轮次带自己的事，她在形状控制下只剩 12–15%
    test('带自己的事（agenda）：没开不抽；开了约四分之一，只在意图行不拦着的轮次，这样的轮次至少 medium、至少 2 条、不再“顺着说”', () => {
        assert.ok(sample('在干嘛啊你', 600).every(plan => !plan.agenda), '没开就一轮也没有');
        const plans = sample('在干嘛啊你', 1500, { agenda: true });
        const withAgenda = plans.filter(plan => plan.agenda);
        assert.ok(Math.abs(withAgenda.length / plans.length - AGENDA_SHARE) < 0.04, `agenda ${withAgenda.length / plans.length}`);
        assert.ok(withAgenda.every(plan => plan.cap >= 14 && plan.maxBubbles >= 2 && !plan.plain), JSON.stringify(withAgenda.find(plan => plan.cap < 14 || plan.maxBubbles < 2 || plan.plain)));
        // 其余的轮次和不开的时候一模一样（同一个种子，别的抽签不动）
        const baseline = sample('在干嘛啊你', 1500);
        plans.forEach((plan, i) => { if (!plan.agenda) assert.deepEqual(plan, baseline[i]); });
        // 不适用的轮次一轮也没有：收尾、认真接话（难受 / 好事 / 问起她认识的人）、亲近 / 撒娇、心情安静
        for (const extra of [
            { intent: '[这一轮你想：顺着他的话收尾，只回一两句]' },
            { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' },
            { intent: '[这一轮你想：他刚说了件好事，替他高兴]' },
            { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' },
            { aboutPerson: true },
            { low: true },
            { initiating: true },
            // 这些意图行明着不让另起话题 / 转去讲自己（或者本来就让她接着说她那边的事）：加一句自己的事会和它打架
            { intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' },
            { intent: '[这一轮你想：先把上面你答应的那件事说了，不另起话题]' },
            { intent: '[这一轮你想：回两句就去忙，不铺开新话题]' },
            { intent: '[这一轮你想：只接他刚说的你们两个人的事，一两句就够；不转去讲猫、书或手头的进度]' },
            { intent: '[这一轮你想：先回他刚说的；你今天买到了相机，还没跟他说过，接着就说这件（看「你那边」那一行，没写的细节不编）]' },
        ]) {
            assert.ok(sample('在干嘛啊你', 400, { agenda: true, ...extra }).every(plan => !plan?.agenda), JSON.stringify(extra));
        }
        // 他在呜呜 / 哭 / 嘤嘤：不转头说自己的事（玩笑式的呜呜呜也算，意图行不一定认得出）
        for (const text of ['呜呜呜', '呜呜你好狠', '嘤嘤嘤', '我想哭']) assert.ok(sample(text, 300, { agenda: true }).every(plan => !plan.agenda), text);
        // 他在说倒霉事（意图行认不出来的）：不带自己的事、不只回一个词（第二次重放里「悲，U盘坏了」后面她挂了一句“我这边在捣鼓新相机”）
        for (const text of ['悲，U盘坏了', '今天倒霉透了', '手机摔了', '这课惨啊', '失眠了']) {
            assert.ok(sample(text, 300, { agenda: true, filler: true }).every(plan => !plan.agenda && !plan.filler), text);
        }
        // 意图行不拦着的：没有意图行、或者「回应他刚说的那件事」，都照常抽
        for (const extra of [{}, { intent: '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应（意外、羡慕、心疼、吐槽一句都行），别急着追问细节，真要问也只问一两个字]' }]) {
            const some = sample('在干嘛啊你', 1000, { agenda: true, ...extra }).filter(plan => plan.agenda).length / 1000;
            assert.ok(Math.abs(some - AGENDA_SHARE) < 0.05, JSON.stringify(extra) + ' ' + some);
        }
    });

    test('带自己的事的那一行：先回他的话，只从她那边已有的事实 / 身体 / 心情里挑，没有合适的就不说、不编，说完不问他', () => {
        const line = describeShape({ kind: 'medium', cap: 14, maxBubbles: 2, agenda: true });
        assert.ok(line.startsWith('[这一轮说话：') && line.endsWith(']'), line);
        assert.ok(line.includes('先回他刚说的') && line.includes('你自己的事') && line.includes('「你那边」') && line.includes('「你的身体」') && line.includes('「你今天的心情」') && line.includes('更别编') && line.includes('不用问他'), line);
        assert.ok(!line.includes('顺着他说就行'), '带事的轮次不同时“顺着说”');
        assert.ok(!describeShape({ kind: 'medium', cap: 14, maxBubbles: 2 }).includes('你自己的事'));
    });

    // ADR 0095：真人聊天里有不带内容的话（整轮只有笑 / 语气词 / 应一声 / 叹状态：真人女生 5%、他本人 1.3%、她线上 0.5%）
    test('废话（filler）：没开不抽；开了约 7%，只在他的话短、不是问句、意图行不拦着的轮次；这样的轮次只一条、不超过 4 个字', () => {
        assert.ok(sample('在干嘛啊你', 600).every(plan => !plan.filler), '没开就一轮也没有');
        const plans = sample('在干嘛', 2000, { filler: true });
        const filler = plans.filter(plan => plan.filler);
        assert.ok(Math.abs(filler.length / plans.length - FILLER_SHARE) < 0.02, `filler ${filler.length / plans.length}`);
        assert.ok(filler.every(plan => plan.kind === 'micro' && plan.cap === 4 && plan.maxBubbles === 1 && !plan.plain && !plan.agenda));
        // 其余轮次和不开时一模一样
        const baseline = sample('在干嘛', 2000);
        plans.forEach((plan, i) => { if (!plan.filler) { const { drawl: _drawl, ...rest } = plan; assert.deepEqual(rest, baseline[i]); } });
        // 他发了一大段、问了问题：不抽
        assert.ok(sample('今天下午我们去了图书馆然后发现没位置就去食堂坐了一会儿', 600, { filler: true }).every(plan => !plan.filler), '他说得长');
        assert.ok(sample('你在干嘛呀？', 600, { filler: true }).every(plan => !plan.filler), '问句');
        // 不适用的轮次一轮也没有：收尾、认真接话、亲近、心情安静、呜呜、意图行拦着的
        for (const extra of [
            { intent: '[这一轮你想：顺着他的话收尾，只回一两句]' },
            { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' },
            { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' },
            { intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' },
            { aboutPerson: true },
            { low: true },
        ]) {
            assert.ok(sample('在干嘛', 600, { filler: true, ...extra }).every(plan => !plan.filler), JSON.stringify(extra));
        }
        assert.ok(sample('呜呜呜', 400, { filler: true }).every(plan => !plan.filler), '呜呜');
    });

    test('废话那一行：定下是哪一种，只回一条、不超过 4 个字、什么都不带；状态那种要和此刻对得上；不问他、不顶嘴', () => {
        const kinds = ['ack', 'laugh', 'drawl', 'state'] as const;
        for (const kind of kinds) {
            const line = describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, filler: kind });
            assert.ok(line.startsWith('[这一轮说话：只回一条，不超过 4 个字，') && line.endsWith(']'), line);
            assert.ok(line.includes('别的什么都不说') && line.includes('不问他') && line.includes('不顶嘴'), line);
            assert.ok(!line.includes('拖音说话'), '他没拖音就不提');
        }
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, filler: 'state' }).includes('对得上'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, filler: 'laugh' }).includes('只笑一下'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, filler: 'ack' }).includes('只应一声'));
        assert.ok(describeShape({ kind: 'micro', cap: 4, maxBubbles: 1, filler: 'drawl', stretch: true }).includes('他在用「～」或拖长音说话'));
    });

    test('四种废话都会抽到，占比大致是应声 35% / 笑 25% / 拖音 20% / 状态 20%', () => {
        const filler = sample('在干嘛', 6000, { filler: true }).filter(plan => plan.filler);
        assert.ok(filler.length > 300);
        const share = (kind: string) => filler.filter(plan => plan.filler === kind).length / filler.length;
        for (const [kind, want] of [['ack', 0.35], ['laugh', 0.25], ['drawl', 0.2], ['state', 0.2]] as const) assert.ok(Math.abs(share(kind) - want) < 0.07, `${kind} ${share(kind)}`);
    });

    test('他在拖音（～、啊啊啊）时她约六成的轮次也跟着拖；他没拖就不加；没开 filler 不加', () => {
        const stretched = sample('说点什么呢～', 1500, { filler: true });
        const share = stretched.filter(plan => plan.stretch).length / stretched.length;
        assert.ok(Math.abs(share - STRETCH_SHARE) < 0.05, `stretch ${share}`);
        assert.ok(sample('说点什么呢', 600, { filler: true }).every(plan => !plan.stretch), '他没拖');
        assert.ok(sample('呜呜呜', 400, { filler: true }).every(plan => !plan.stretch), '呜呜是难受 / 撒娇，不是拖音');
        assert.ok(sample('哈哈哈哈', 400, { filler: true }).every(plan => !plan.stretch), '哈哈是笑，不是拖音');
        assert.ok(sample('啊啊啊好忙', 400, { filler: true }).some(plan => plan.stretch), '啊啊啊算拖音');
        assert.ok(sample('说点什么呢～', 600).every(plan => !plan.stretch), '没开');
        assert.ok(sample('啊啊啊好烦', 300, { filler: true, intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' }).every(plan => !plan.stretch), '认真接话时不跟着拖');
        const withNote = describeShape({ kind: 'short', cap: 8, maxBubbles: 1, plain: true, stretch: true });
        assert.ok(withNote.includes('顺着他说就行') && withNote.includes('拖个音') && withNote.endsWith(']'), withNote);
        assert.ok(!describeShape({ kind: 'short', cap: 8, maxBubbles: 1, plain: true }).includes('拖个音'));
    });

    // ADR 0096：条数本来只是上限，真模型多半只写一行（线上 / 重放 85% 是 1 条，真人女生 59%）；开了就把它当成目标写进提示词
    test('分成几条（split）：没开不带；开了抽到 2 / 3 条的非极短轮次带 parts（等于 maxBubbles），其余不带；其余的字段和不开时一模一样', () => {
        assert.ok(sample('在干嘛啊你', 600).every(plan => plan.parts === undefined), '没开就没有');
        const plans = sample('在干嘛啊你', 2000, { split: true });
        const baseline = sample('在干嘛啊你', 2000);
        plans.forEach((plan, i) => {
            const { parts, ...rest } = plan;
            assert.deepEqual(rest, baseline[i]);
            if (parts !== undefined) assert.ok(plan.kind !== 'micro' && plan.maxBubbles === parts && parts >= 2, JSON.stringify(plan));
            else assert.ok(plan.kind === 'micro' || plan.maxBubbles === 1, JSON.stringify(plan));
        });
        const multi = plans.filter(plan => plan.parts).length / plans.length;
        assert.ok(multi > 0.28 && multi < 0.5, `multi ${multi}`);
        // 收尾的轮次不分
        assert.ok(sample('晚安啦我先睡了', 400, { split: true, intent: '[这一轮你想：顺着他的话收尾，只回一两句]' }).every(plan => plan.parts === undefined));
    });

    test('分成几条那一句：写明条数、一条一行、一个小意思；带自己的事的轮次条数写进计数、事的说法用自己的那句', () => {
        const line = describeShape({ kind: 'medium', cap: 14, maxBubbles: 2, parts: 2 });
        assert.ok(line.includes('每条不超过 14 个字，分成 2 条发') && !line.includes('最多 2 条'), line);
        assert.ok(line.includes('一条一行') && line.includes('一个小意思') && line.includes('不是把一句话硬断成两截') && line.includes('不是反问') && line.includes('没有就别硬问'), line);
        // ADR 0134：后面几条顺着前一条说，不改口、不另起不相干的事、不凑数
        for (const phrase of ['顺着它往下说', '选了哪个就按选的说下去', '别又提没选的', '别改口', '别另起一件不相干的事', '换个说法再说一遍', '就少发一条，别凑数']) assert.ok(line.includes(phrase), phrase);
        assert.ok(!line.includes('接一句补充'), line);
        assert.ok(describeShape({ kind: 'short', cap: 8, maxBubbles: 3, parts: 3 }).includes('分成 3 条发'));
        const agenda = describeShape({ kind: 'medium', cap: 14, maxBubbles: 2, parts: 2, agenda: true });
        assert.ok(agenda.includes('分成 2 条发') && agenda.includes('回完顺带说一句你自己的事') && !agenda.includes('一个小意思'), agenda);
        assert.ok(describeShape({ kind: 'medium', cap: 14, maxBubbles: 2 }).includes('最多 2 条'), '没有 parts 还是上限');
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

// ADR 0098：带自己的事的轮次里这一次说哪一件，按轮抽（72 句真人对话测：开了带事以后 21% 的回复提到相机 / 团子饼 / 作业 / 快递，相机一件就 14%——模型总挑同两件）
describe('带自己的事：这一次说哪一件（agendaTopic）', () => {
    test('给了候选就从里面抽、各件都会抽到；没给候选就没有；不带事的轮次没有', () => {
        const topics = ['作业', '天气', '身体', '心情', '快递'];
        const plans = sample('在干嘛', 3000, { agenda: true, agendaTopics: topics });
        const withTopic = plans.filter(plan => plan.agenda);
        assert.ok(withTopic.length > 300);
        assert.ok(withTopic.every(plan => plan.agendaTopic !== undefined && topics.includes(plan.agendaTopic)));
        for (const topic of topics) assert.ok(withTopic.filter(plan => plan.agendaTopic === topic).length > 40, topic);
        assert.ok(plans.filter(plan => !plan.agenda).every(plan => plan.agendaTopic === undefined));
        assert.ok(sample('在干嘛', 1000, { agenda: true }).every(plan => plan.agendaTopic === undefined), '没给候选');
        // 其余字段和不给候选时一模一样
        const base = sample('在干嘛', 3000, { agenda: true });
        plans.forEach((plan, i) => { const { agendaTopic: _topic, ...rest } = plan; assert.deepEqual(rest, base[i]); });
    });

    test('提示词里写明就说这一件，并且没写的细节不编', () => {
        const line = describeShape({ kind: 'medium', cap: 14, maxBubbles: 2, agenda: true, agendaTopic: '作业' });
        assert.ok(line.includes('就说「作业」这一件') && line.includes('没写的细节不编') && line.includes('说完不用问他'), line);
        const free = describeShape({ kind: 'medium', cap: 14, maxBubbles: 2, agenda: true });
        assert.ok(free.includes('挑一件他还不知道的') && !free.includes('这一件（看'), free);
    });
});

// ADR 0098：他自己线上的话 11% 带「～」或「…」，她 0%
describe('语气松一点（drawl）：句尾可以带「～」或「……」', () => {
    test('没开 filler 不带；开了约 12%；不是认真接话 / 收尾 / 他说倒霉事 / 呜呜；和“跟着他拖音”不同时出现', () => {
        assert.ok(sample('在干嘛啊你', 600).every(plan => !plan.drawl), '没开就没有');
        const plans = sample('在干嘛啊你', 3000, { filler: true });
        const share = plans.filter(plan => plan.drawl).length / plans.length;
        assert.ok(Math.abs(share - DRAWL_SHARE) < 0.03, `drawl ${share}`);
        for (const [text, extra] of [
            ['晚安啦我先睡了', { intent: '[这一轮你想：顺着他的话收尾，只回一两句]' }],
            ['今天好烦', { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' }],
            ['悲，U盘坏了', {}], ['呜呜呜', {}],
        ] as const) assert.ok(sample(text, 400, { filler: true, ...extra }).every(plan => !plan.drawl), text);
        assert.ok(sample('说点什么呢～', 600, { filler: true }).every(plan => !(plan.drawl && plan.stretch)), '他拖了音就走跟着拖那一路');
        const line = describeShape({ kind: 'short', cap: 8, maxBubbles: 1, drawl: true });
        assert.ok(line.includes('句尾可以带个「～」或者「……」') && line.includes('别每句都这样') && line.endsWith(']'), line);
        assert.ok(!describeShape({ kind: 'short', cap: 8, maxBubbles: 1 }).includes('句尾可以带个'));
    });
});

// ADR 0099：情绪轮——这一轮先说自己对他的一点小情绪，不把他的话处理完整
describe('情绪轮（feel）：先说自己对他的小情绪', () => {
    test('没开不抽；开了约 27%（0.3 里先扣掉废话轮次的 10%），一两条、每条不超过 10 个字，不带自己的事、不“顺着说”', () => {
        assert.ok(sample('想你了呀', 600).every(plan => !plan.feel), '没开就一轮也没有');
        const plans = sample('我肯定行啊', 3000, { feel: true, agenda: true, filler: true });
        const feel = plans.filter(plan => plan.feel);
        assert.ok(Math.abs(feel.length / plans.length - FEEL_SHARE * (1 - FILLER_SHARE)) < 0.03, `feel ${feel.length / plans.length}`);
        assert.ok(feel.every(plan => plan.kind === 'short' && plan.cap === 10 && plan.maxBubbles <= 2 && !plan.plain && !plan.agenda && !plan.filler && !plan.parts));
        assert.ok(feel.some(plan => plan.maxBubbles === 1) && feel.some(plan => plan.maxBubbles === 2));
    });

    test('只在“自由”的轮次、他说得不长时出现：收尾、认真接话、亲近、心情安静、意图行拦着（问问题）、他在呜呜 / 倒霉、他发了一大段都不抽', () => {
        for (const [text, extra] of [
            ['晚安啦我先睡了', { intent: '[这一轮你想：顺着他的话收尾，只回一两句]' }],
            ['今天好烦', { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' }],
            ['想你了', { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' }],
            ['你吃了吗', { intent: '[这一轮你想：先直接回答他刚问的，不另起话题]' }],
            ['在干嘛', { aboutPerson: true }], ['在干嘛', { low: true }],
            ['呜呜呜', {}], ['悲，U盘坏了', {}], ['我没咋啊，我情绪不对你就别问了', {}], ['宝宝我有点不舒服', {}],
            ['今天下午我们去了图书馆然后发现没位置就去食堂坐了一会儿然后又去了操场走了两圈最后回宿舍洗了个澡', {}],
        ] as const) assert.ok(sample(text, 500, { feel: true, ...extra }).every(plan => !plan.feel), text);
        // 意图行是「回应他刚说的那件事」（最常见的一条）不拦着
        assert.ok(sample('我肯定行啊', 800, { feel: true, intent: '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应]' }).some(plan => plan.feel));
    });

    test('开了情绪轮，其余轮次和不开时一模一样（抽签互不影响）', () => {
        const base = sample('我肯定行啊', 1500, { agenda: true, filler: true });
        const withFeel = sample('我肯定行啊', 1500, { agenda: true, filler: true, feel: true });
        withFeel.forEach((plan, i) => { if (!plan.feel) { const { pushback: _pushback, ...rest } = plan; assert.deepEqual(rest, base[i]); } });
    });

    test('不马上让步（pushback）：开了情绪轮才有；收尾 / 认真接话 / 亲近的轮次没有；提示词里多一句“别一本正经认错”，不引用台词，也不叫她顶回去', () => {
        assert.ok(sample('你太懒了吧', 300).every(plan => !plan.pushback), '没开就没有');
        assert.ok(sample('你太懒了吧', 300, { feel: true }).every(plan => plan.feel || plan.pushback), '开了：非情绪轮的普通轮次都带');
        for (const extra of [
            { intent: '[这一轮你想：顺着他的话收尾，只回一两句]' },
            { intent: '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够]' },
            { intent: '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事]' },
        ]) assert.ok(sample('你太懒了吧', 300, { feel: true, ...extra }).every(plan => !plan.pushback), JSON.stringify(extra));
        const line = describeShape({ kind: 'short', cap: 8, maxBubbles: 1, plain: true, pushback: true });
        for (const part of ['说你的不是、叮嘱你或拿你开玩笑', '别一本正经地认错、答应改、保证以后', '夸张地装崩溃、装可怜', '带点委屈']) assert.ok(line.includes(part), part);
        assert.ok(line.includes('别反驳他、别损他、别嘴硬'), '顺着说那句还在，这里不叫她顶回去');
        assert.ok(!describeShape({ kind: 'short', cap: 8, maxBubbles: 1, plain: true }).includes('一本正经'));
        assert.ok(!/我会注意|行吧|好好好|知道啦/.test(line), '不引用不想要的那句');
    });

    test('情绪轮那一行：给“他说了什么 → 哪种情绪”，不给台词；不安慰、不解释、不追问；夸张只是玩笑、不涉及伤害自己；搭不上就照平常回；可以带拖音', () => {
        const line = describeShape({ kind: 'short', cap: 10, maxBubbles: 1, feel: true });
        for (const part of ['不用把他的话回应完整', '撒个娇', '夸张地装崩溃', '不是真的难过，更不涉及伤害自己', '小声委屈或赌气', '考验他一下', '害羞地嘴硬', '叹一声', '不安慰他', '不去追问他', '就照平常回', '只回一条']) assert.ok(line.includes(part), part);
        assert.ok(!line.includes('顺着他说就行'), '和“顺着说”不同时出现');
        assert.ok(!/怎么了|咋了|我不活了|抱抱|mua/.test(line), '不给台词、不引用不想要的那句');
        assert.ok(describeShape({ kind: 'short', cap: 10, maxBubbles: 2, feel: true }).includes('最多 2 条'));
        assert.ok(describeShape({ kind: 'short', cap: 10, maxBubbles: 1, feel: true, drawl: true }).includes('句尾可以带个'));
        assert.ok(line.endsWith(']'));
    });
});

describe('情绪轮的出口：不拿“不想活”开玩笑（ADR 0099）', () => {
    const feel: ShapePlan = { kind: 'short', cap: 10, maxBubbles: 2, feel: true };
    const make = (reply: string | Error, notes: string[] = [], logs: string[] = []) => ({ regenerate: async (note: string) => { notes.push(note); if (reply instanceof Error) throw reply; return reply; }, log: (m: string) => logs.push(m) });

    test('情绪轮 / 不马上让步的轮次里出现「我不活了」「想死」「去死」这类字眼：带说明重写一次，重写合格就用重写的；日常夸张（笑死了、累死了）不算', async () => {
        const notes: string[] = [];
        assert.equal(await shapeReply('完了\n我不活了', feel, make('丢死人了', notes)), '丢死人了');
        assert.equal(notes.length, 1);
        assert.ok(notes[0]!.startsWith('[上一版回复没有发出去') && notes[0]!.includes('你是陪伴程序，不拿这个开玩笑') && !notes[0]!.includes('太长了'), notes[0]);
        for (const ok of ['笑死了', '累死了', '困死了', '丢人死了']) {
            const quiet: string[] = [];
            assert.equal(await shapeReply(ok, feel, make('不该到这里', quiet)), ok, ok);
            assert.equal(quiet.length, 0, ok);
        }
        for (const bad of ['我不想活了', '想死', '你去死吧', '我死了', '活不下去了']) {
            const q: string[] = [];
            await shapeReply(bad, feel, make('好了', q));
            assert.equal(q.length, 1, bad);
        }
    });

    test('重写后还有就把那几行去掉；重写失败也去掉；太长和字眼一起出现时说明里两件事都写', async () => {
        const logs: string[] = [];
        assert.equal(await shapeReply('完了\n我不活了', feel, make('还是不活了\n好丢人', [], logs)), '好丢人');
        assert.ok(logs.some(line => line.includes('那几行去掉')));
        assert.equal(await shapeReply('完了\n我不活了', feel, make(new Error('429'))), '完了');
        const notes: string[] = [];
        await shapeReply('今天真的好累啊而且还要写作业我不活了烦死了真的', feel, make('丢人', notes));
        assert.ok(notes[0]!.includes('太长了') && notes[0]!.includes('不拿这个开玩笑'), notes[0]);
    });

    test('只在带情绪轮 / 不马上让步说明的轮次检查：别的轮次原样放行（她说自己难过的话不归这里管）', async () => {
        const quiet: string[] = [];
        assert.equal(await shapeReply('我不活了', { kind: 'short', cap: 8, maxBubbles: 2 }, make('x', quiet)), '我不活了');
        assert.equal(quiet.length, 0);
        const push: string[] = [];
        await shapeReply('我不活了', { kind: 'short', cap: 8, maxBubbles: 2, plain: true, pushback: true }, make('丢人', push));
        assert.equal(push.length, 1, '不马上让步的轮次也查');
    });
});

describe('被问直接问题时答完再接着说（shapeAsk，ADR 0149）', () => {
    const ASK = '[这一轮你想：先直接回答他刚问的，不另起话题]';
    const mean = (plans: ShapePlan[]) => plans.reduce((sum, plan) => sum + plan.maxBubbles, 0) / plans.length;

    test('没开：照旧；开了但意图行不是「先直接回答」：也照旧', () => {
        const off = sample('你今天吃了什么呀', 600, { intent: ASK });
        const other = sample('你今天吃了什么呀', 600, { intent: '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应]', ask: true });
        const baseline = sample('你今天吃了什么呀', 600, { intent: '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应]' });
        assert.deepEqual(other, baseline);
        assert.ok(off.some(plan => plan.plain), '没开时仍是 70% 左右的轮次带「顺着他说」');
    });

    test('开了：被问问题的轮次不再带「应一声、附和」，条数平均从约 1.6 挪到约 1.8', () => {
        const off = sample('你今天吃了什么呀', 900, { intent: ASK });
        const on = sample('你今天吃了什么呀', 900, { intent: ASK, ask: true });
        assert.ok(off.filter(plan => plan.plain).length > 400);
        assert.equal(on.filter(plan => plan.plain).length, 0);
        assert.ok(mean(on) - mean(off) > 0.15, `${mean(off)} → ${mean(on)}`);
        assert.ok(Math.abs(mean(on) - 1.8) < 0.12, `${mean(on)}`);
        assert.ok(on.filter(plan => plan.maxBubbles === 1).length / on.length < 0.46);
    });

    test('每条多长不动：同一句话抽到的字数档和没开时逐个一样（只改条数和那一句）', () => {
        const off = sample('你今天吃了什么呀', 300, { intent: ASK });
        const on = sample('你今天吃了什么呀', 300, { intent: ASK, ask: true });
        assert.deepEqual(on.map(plan => plan.cap), off.map(plan => plan.cap));
    });

    test('收尾、亲近的轮次不受影响（它们的意图行本来就不是「先直接回答」）；说明里的话照旧', () => {
        const on = planShape({ history: said(5, '你今天吃了什么呀'), intent: ASK, ask: true })!;
        assert.ok(!describeShape(on).includes('应一声'), describeShape(on));
        const closing = sample('晚安啦', 300, { intent: '[这一轮你想：顺着他的话收尾，只回一两句]', ask: true });
        assert.ok(closing.every(plan => plan.maxBubbles <= 2));
    });
});

describe('被认真问想法时说长一点（shapeLong，ADR 0150）', () => {
    const ASK = '[这一轮你想：先直接回答他刚问的，不另起话题]';
    const ABSTRACT = '[这一轮你想：他在问一个很大、很抽象的问题。别总结成一句漂亮话]';

    test('哪些轮次算「认真问她」：很大很抽象的问题；或「先直接回答」的轮次里问的是想法 / 原因，且带问句。问「吃了吗」不算', () => {
        assert.equal(invitesLong(ABSTRACT, '你说谈恋爱到底是什么样子的？'), true);
        assert.equal(invitesLong(ASK, '你觉得我该不该去？'), true);
        assert.equal(invitesLong(ASK, '为什么你不爱我了'), false, '没有问句的标记（吗 / 呢 / ？）');
        assert.equal(invitesLong(ASK, '你吃了吗'), false);
        assert.equal(invitesLong(ASK, '你觉得呢'), true);
        assert.equal(invitesLong(undefined, '你觉得我该不该去？'), false, '没有意图行不算');
        assert.equal(invitesLong('[这一轮你想：顺着他的话收尾]', '你为什么这样？'), false);
    });

    test('没开：照旧；开了但不是认真问的轮次：也照旧', () => {
        const plain = sample('你今天吃了什么呀', 300, { intent: ASK });
        const flagged = sample('你今天吃了什么呀', 300, { intent: ASK, long: true });
        assert.deepEqual(flagged, plain);
        const off = sample('你觉得我该不该去北京？', 300, { intent: ASK });
        assert.ok(off.every(plan => !plan.long));
    });

    test(`开了：认真问想法的轮次约 ${LONG_SHARE * 100}% 拉长到每条 ${LONG_CAP} 字、1–3 条；其余照旧`, () => {
        const on = sample('你觉得我该不该去北京？', 900, { intent: ASK, long: true });
        const longOnes = on.filter(plan => plan.long);
        assert.ok(Math.abs(longOnes.length / on.length - LONG_SHARE) < 0.06, `${longOnes.length / on.length}`);
        assert.ok(longOnes.every(plan => plan.cap === LONG_CAP && plan.maxBubbles >= 1 && plan.maxBubbles <= 3 && !plan.plain));
        assert.ok(new Set(longOnes.map(plan => plan.maxBubbles)).size === 3, '1、2、3 条都会抽到');
        const rest = on.filter(plan => !plan.long);
        assert.ok(rest.every(plan => plan.cap <= 40));
    });

    test('不拉长：心情安静 / 身体不舒服、亲近、收尾', () => {
        const low = sample('你觉得我该不该去北京？', 300, { intent: ASK, long: true, low: true });
        assert.ok(low.every(plan => !plan.long));
        const closing = sample('你觉得呢？晚安', 300, { intent: '[这一轮你想：顺着他的话收尾，只回一两句]', long: true });
        assert.ok(closing.every(plan => !plan.long));
    });

    test('提示词：让她把想法说清楚，不要排比 / 金句 / 讲道理，没想过就说没想过；开了拆条就写分成几条', () => {
        const plan = sample('你觉得我该不该去北京？', 200, { intent: ASK, long: true, split: true }).find(p => p.long && p.parts)!;
        const text = describeShape(plan);
        assert.ok(text.includes('认真在问') && text.includes(`${LONG_CAP} 个字`) && text.includes(`分成 ${plan.parts} 条`), text);
        assert.ok(text.includes('不要排比') && text.includes('没想过的就说没想过'), text);
    });
});

describe('深思（deliberate，ADR 0151）：哪些轮次算「他在认真问她」', () => {
    const ASK = '[这一轮你想：先直接回答他刚问的，不另起话题]';
    const ABSTRACT = '[这一轮你想：他在问一个很大、很抽象的问题。别总结成一句漂亮话]';
    const STALL = '[这一轮你想：他在追你要一个答案，你前面已经推了好几次了]';
    const CHALLENGE = '[这一轮你想：他在说你的话不像真人、重复或者敷衍。别替自己辩解]';

    test('算：很大很抽象的问题；问想法 / 原因 / 该不该；追着要答案；说她不像真人；他明着让她讲', () => {
        assert.equal(deliberateTurn(ABSTRACT, '你说谈恋爱到底是什么样子的？', false), true);
        assert.equal(deliberateTurn(ASK, '你觉得我该不该去北京实习？', false), true);
        assert.equal(deliberateTurn(ASK, '这件事我该怎么办呢', false), true);
        assert.equal(deliberateTurn(STALL, '回答我，你愿意吗', false), true);
        assert.equal(deliberateTurn(CHALLENGE, '你总是这样，敷衍', false), true);
        assert.equal(deliberateTurn(undefined, '帮我详细讲讲梯度下降', true), true);
    });

    test('不算：闲聊式的问句（在干嘛、吃了吗、要不要一起吃饭）、没有问句标记的、收尾、没有意图行', () => {
        assert.equal(deliberateTurn(ASK, '在干嘛呢', false), false);
        assert.equal(deliberateTurn(ASK, '你吃了吗', false), false);
        assert.equal(deliberateTurn(ASK, '要不要一起吃饭呀', false), false);
        assert.equal(deliberateTurn(ASK, '我觉得为什么都这样', false), false, '没有问句标记');
        assert.equal(deliberateTurn('[这一轮你想：顺着他的话收尾，只回一两句]', '你觉得呢？晚安', false), false);
        assert.equal(deliberateTurn(undefined, '你觉得我该不该去北京实习？', false), false);
    });

    test('提示词只说「先想什么」，不说多长、几条；保留不要排比 / 金句 / 编造', () => {
        assert.doesNotMatch(DELIBERATE_NOTE, /\d+\s*个字|最多\s*\d+\s*条|每条不超过/);
        assert.match(DELIBERATE_NOTE, /先在心里想清楚/);
        assert.match(DELIBERATE_NOTE, /别排比/);
        assert.match(DELIBERATE_NOTE, /不知道就说不知道，别编/);
    });
});
