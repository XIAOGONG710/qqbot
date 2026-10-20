import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ENGAGED_INTENT } from '../src/expression.ts';
import { describeGrievance, GRIEVANCE_GAP_MS, grievanceNow, ignoredNow, IGNORED_GAP_MS, IGNORED_MAX_MS, isRepairText, MAKEUP_MARK, SULK_MARK } from '../src/grievance.ts';
import { describeIntent } from '../src/intent.ts';

const NOW = Date.parse('2026-10-16T20:00:00+08:00');
const HOUR = 3_600_000;
const at = (hoursFromNow: number) => new Date(NOW + hoursFromNow * HOUR).toISOString();
type Role = 'user' | 'assistant';
const m = (role: Role, hoursFromNow: number, content: string) => ({ role, time: at(hoursFromNow), content });

/** 他 4 天前最后说话，这几天她主动发过一条没人回，今天他回来 */
const away = (arrival: string, ...later: ReturnType<typeof m>[]) => [
    m('user', -100, '晚安'), m('assistant', -99.9, '晚安'),
    m('assistant', -60, '睡前随口说一句：今天下课好晚'),
    m('user', -1, arrival),
    ...later,
];

describe('小别扭的触发（ADR 0074）：只有「隔了很多天才来，而且她发的一直没回」', () => {
    test('隔了 4 天、这几天她发过话没人回、他回来什么都没解释：第一轮别扭，说得出隔了几天', () => {
        const grievance = grievanceNow(away('在吗'));
        assert.deepEqual(grievance, { stage: 'sulk', days: 4, round: 0 });
        assert.match(describeGrievance(grievance!), /他已经 4 天没来找你/);
    });

    test('天数四舍五入：3 天 23 小时说 4 天，3 天零几小时说 3 天', () => {
        const gapDays = (hours: number) => grievanceNow([m('user', -1 - hours, '晚安'), m('assistant', -hours, '睡吧'), m('assistant', -hours / 2, '在吗'), m('user', -1, '在')])!.days;
        assert.equal(gapDays(95), 4);
        assert.equal(gapDays(73), 3);
        assert.equal(gapDays(100), 4);
        assert.equal(gapDays(24 * 7), 7);
    });

    test('刚好 3 天算，差一点不算；这几天她什么都没发（没有被晾着）不算', () => {
        const mk = (gapHours: number) => [m('user', -1 - gapHours, '晚安'), m('assistant', -gapHours, '睡吧'), m('assistant', -gapHours / 2, '在吗'), m('user', -1, '在')];
        assert.equal(grievanceNow(mk(GRIEVANCE_GAP_MS / HOUR))!.stage, 'sulk');
        assert.equal(grievanceNow(mk(GRIEVANCE_GAP_MS / HOUR - 1)), undefined);
        const silentHer = [m('user', -100, '晚安'), m('user', -1, '在吗')];
        assert.equal(grievanceNow(silentHer), undefined, '她没发过话，谈不上被晾着');
        const herBeforeOnly = [m('user', -100, '晚安'), m('assistant', -99, '晚安啦'), m('user', -1, '在吗')];
        assert.equal(grievanceNow(herBeforeOnly), undefined, '她只回了他最后那句晚安，之后没再发过，也谈不上被晾着');
    });

    test('他事先说过要消失几天（考试周 / 出差 / 没网）：不是被晾着，不别扭', () => {
        for (const notice of ['这几天要考试，可能不太回你', '下周出差，没网', '考试周了我先消失几天', '我这阵子忙，期末']) {
            const history = [m('user', -101, notice), m('assistant', -100.5, '好，加油'), m('user', -100, '先睡了'), m('assistant', -60, '在不在'), m('user', -1, '在吗')];
            assert.equal(grievanceNow(history), undefined, notice);
        }
    });

    test('没有待回的话（主动找他）、没有时间的记录：不算', () => {
        assert.equal(grievanceNow([m('user', -100, '晚安'), m('assistant', -60, '在吗')]), undefined);
        assert.equal(grievanceNow([]), undefined);
        assert.equal(grievanceNow([{ role: 'user', content: '晚安' }, { role: 'assistant', content: '嗯' }, { role: 'user', content: '在吗' }]), undefined);
    });

    test('他回来时就带着道歉 / 解释 / 哄 / 想念：不别扭（余温交给 ADR 0028）', () => {
        for (const arrival of ['对不起啊这几天没理你', '这几天太忙了', '想你了', '我错了别生气', '抱抱你', '手机坏了才修好']) {
            assert.equal(grievanceNow(away(arrival)), undefined, arrival);
        }
        // 一串里先「在吗」后「对不起」也算
        assert.equal(grievanceNow([...away('在吗').slice(0, 3), m('user', -1, '在吗'), m('user', -0.9, '对不起')]), undefined);
    });
});

describe('别扭的过程：两轮之内回暖，一哄就和好，不跨天', () => {
    test('第一轮别扭 → 第二轮自然回暖（他没哄）→ 第三轮起没有', () => {
        const first = away('在吗');
        assert.equal(grievanceNow(first)!.round, 0);
        const second = [...first, m('assistant', -0.9, '嗯，在。'), m('user', -0.8, '在干嘛')];
        assert.deepEqual(grievanceNow(second), { stage: 'sulk', days: 4, round: 1 });
        assert.match(describeGrievance(grievanceNow(second)!), /回暖/);
        const third = [...second, m('assistant', -0.7, '刷手机'), m('user', -0.6, '哦')];
        assert.equal(grievanceNow(third), undefined, '最多别扭两轮');
    });

    test('她别扭了一轮之后他道歉 / 解释 / 哄：这一轮和好；和好之后不再别扭、也不再重复和好', () => {
        const first = away('在吗');
        const apology = [...first, m('assistant', -0.9, '嗯，在。'), m('user', -0.8, '对不起啊这几天没理你')];
        assert.deepEqual(grievanceNow(apology), { stage: 'makeup', days: 4, round: 1 });
        assert.match(describeGrievance(grievanceNow(apology)!), new RegExp(MAKEUP_MARK));
        for (const repair of ['这几天赶论文，手机都没看', '想你了嘛', '抱抱，别生气了']) {
            assert.equal(grievanceNow([...first, m('assistant', -0.9, '嗯'), m('user', -0.8, repair)])!.stage, 'makeup', repair);
        }
        const after = [...apology, m('assistant', -0.7, '行吧，下次说一声'), m('user', -0.6, '好')];
        assert.equal(grievanceNow(after), undefined, '和好以后就没有了');
        const twice = [...apology, m('assistant', -0.7, '行吧'), m('user', -0.6, '真的对不起')];
        assert.equal(grievanceNow(twice), undefined, '第二次道歉不再触发和好');
    });

    test('他回来后隔了 3 小时以上再说话：不接着上一次的别扭；隔天更不会', () => {
        const first = away('在吗');
        const later = [...first, m('assistant', -0.9, '嗯，在。'), m('user', 3, '在干嘛')];
        assert.equal(grievanceNow(later), undefined);
    });

    test('不落盘、可重算：同一份记录算两遍结果一样（重启之后得到的是同一个结果）', () => {
        const history = away('在吗');
        assert.deepEqual(grievanceNow(history), grievanceNow([...history]));
    });

    test('老的大间隔不影响：只看最近的那一次，更早的间隔和现在无关', () => {
        const history = [
            m('user', -400, '晚安'), m('assistant', -399, '晚安'), m('assistant', -300, '在吗'), m('user', -200, '来了'), m('assistant', -199.9, '嗯'),
            m('user', -199.8, '你好'), m('assistant', -199.7, '嗯'), m('user', -2, '在吗'),
        ];
        assert.equal(grievanceNow(history), undefined, '最近一次间隔只有 8 天里的零头，不到 3 天');
    });
});

describe('意图行的边界', () => {
    const now = new Date(NOW);

    test('只给方向不给台词；说得出天数；第二轮回暖；和好软下来', () => {
        const sulk = describeGrievance({ stage: 'sulk', days: 4, round: 0 });
        const back = describeGrievance({ stage: 'sulk', days: 4, round: 1 });
        const makeup = describeGrievance({ stage: 'makeup', days: 4, round: 1 });
        assert.match(sulk, new RegExp(SULK_MARK));
        for (const line of [sulk, back, makeup]) {
            assert.doesNotMatch(line, /[「“"]/, '不给可以照抄的台词');
            assert.ok(line.startsWith('[这一轮你想：') && line.endsWith(']'));
        }
        for (const forbidden of ['不翻旧账', '不质问', '不说教', '不让他内疚', '不是真生气', '不是冷战']) assert.ok(sulk.includes(forbidden), forbidden);
        assert.match(describeGrievance({ stage: 'sulk', days: 1, round: 0 }), /好几天/);
    });

    test('优先级：危机最高；他难过 / 生病 / 要她哄时让路；收尾时「别扭」让路、「和好」不让；其余盖过问答 / 好事 / 收尾之外的小意图', () => {
        const history = away('在吗');
        const sulk = { stage: 'sulk' as const, days: 4, round: 0 };
        const withGrievance = (h: typeof history) => describeIntent({ history: h, now, grievance: sulk, intimate: true });
        assert.match(withGrievance(history)!, new RegExp(SULK_MARK));
        assert.match(describeIntent({ history: [...history.slice(0, -1), m('user', -1, '你在干嘛')], now, grievance: sulk })!, new RegExp(SULK_MARK), '问句也先别扭一下');
        // 危机最高
        assert.match(describeIntent({ history, now, grievance: sulk, crisis: 'high' })!, /想伤害自己/);
        // 他难过、生病、要她哄：让路给关心 / 哄
        for (const sad of ['我今天好难过', '我发烧了', '我好累']) {
            assert.doesNotMatch(describeIntent({ history: [...history.slice(0, -1), m('user', -1, sad)], now, grievance: sulk })!, new RegExp(SULK_MARK), sad);
        }
        assert.doesNotMatch(describeIntent({ history: [...history.slice(0, -1), m('user', -1, '哄哄我')], now, grievance: sulk, intimate: true })!, new RegExp(SULK_MARK));
        // 收尾：别扭让路；和好不让路
        const goodnight = [...history.slice(0, -1), m('user', -1, '晚安')];
        assert.doesNotMatch(describeIntent({ history: goodnight, now, grievance: sulk }) ?? '', new RegExp(SULK_MARK));
        assert.match(describeIntent({ history: goodnight, now, grievance: { stage: 'makeup', days: 4, round: 1 } })!, new RegExp(MAKEUP_MARK));
        // 主动找他：不给
        assert.equal(describeIntent({ history, now, grievance: sulk, initiating: true }), undefined);
        // 没有 grievance 时和以前一样
        assert.equal(describeIntent({ history: [m('user', -1, '在吗')], now }), undefined, '没有 grievance 时和以前一样');
    });

    test('修补的认法：道歉 / 解释 / 哄 / 想念都算，普通的话不算', () => {
        for (const text of ['对不起', '抱歉啊', '我错了', '别生气嘛', '不好意思', '这几天太忙了', '手机没电了', '想你了', '抱抱', '我的错']) assert.equal(isRepairText(text), true, text);
        for (const text of ['在吗', '你在干嘛', '哦', '好吧', '我刚下课', '今天天气不错']) assert.equal(isRepairText(text), false, text);
    });
});

describe('她倾诉了几条、他隔了很久才回（ignoredNow，10-20 用户：应该要生气，责怪对方玩游戏不理自己）', () => {
    const vent = [m('assistant', -2.2, '你睡了没'), m('assistant', -2.2, '我今天好烦'), m('assistant', -2.1, '实验又被老师骂了'), m('assistant', -1.9, '算了你打游戏吧')];
    const back = (from: number, ...texts: string[]) => texts.map((text, i) => m('user', from + i * 0.01, text));

    test('触发：连发的几条里有难过 / 烦，他过了一个多小时才回、还没哄她', () => {
        const history = [...vent, ...back(-0.8, '刚打完', '咋还没睡', '你发那几条我刚看见', '明天再说行不 我困死了')];
        assert.deepEqual(ignoredNow(history), { stage: 'sulk', days: 0, round: 0, cause: 'ignored' });
    });

    test('意图行：带「小别扭」标记（出口检查放过这一轮的抱怨），不写台词，让「回很短」让路，并且真能走到意图链里', () => {
        const history = [...vent, ...back(-0.8, '刚打完', '你发那几条我刚看见', '明天再说行不 我困死了')];
        const grievance = ignoredNow(history)!;
        const line = describeGrievance(grievance);
        assert.ok(line.includes(SULK_MARK));
        assert.ok(ENGAGED_INTENT.test(line), '不然 shortReplies 会把这一轮压成一句');
        assert.ok(/不翻旧账、不冷战、不长篇大论/.test(line));
        assert.equal(describeIntent({ history, state: undefined, schedule: undefined, now: new Date(NOW), intimate: true, playful: true, grievance }), line);
    });

    test('不触发：他隔得不够久（正常回得慢）、隔得太久（睡一觉才回）', () => {
        assert.equal(ignoredNow([...vent, ...back(-1.9 + (IGNORED_GAP_MS - 60_000) / HOUR, '刚看到')]), undefined);
        assert.equal(ignoredNow([...vent, ...back(-1.9 + (IGNORED_MAX_MS + 60_000) / HOUR, '早啊')]), undefined);
    });

    test('不触发：她只发了一条、或者没有说自己的感受（睡前主动发的那条没人回，第二天他说刚醒）', () => {
        assert.equal(ignoredNow([m('assistant', -2, '我今天好烦'), ...back(-0.5, '刚看到')]), undefined, '只一条');
        assert.equal(ignoredNow([m('assistant', -9, '睡了没'), m('assistant', -9, '我先睡了啊'), ...back(-2.5, '刚醒')]), undefined, '打招呼不算感受、也隔得太久');
        assert.equal(ignoredNow([m('assistant', -2.2, '人呢'), m('assistant', -2.1, '在吗'), ...back(-0.9, '刚才在忙')]), undefined, '没有感受词');
    });

    test('不触发：他回来时已经在道歉 / 解释（交给通用的「先嘴硬再软」）；回过一轮之后不再触发', () => {
        assert.equal(ignoredNow([...vent, ...back(-0.8, '不好意思，刚才在打游戏')]), undefined);
        const replied = [...vent, ...back(-0.8, '刚打完', '你发那几条我刚看见'), m('assistant', -0.7, '你还知道看消息啊'), ...back(-0.6, '明天再说行不')];
        assert.equal(ignoredNow(replied), undefined);
    });

    test('原来的「隔了好几天才来」不受影响：没有 cause 字段', () => {
        const history = [m('user', -100, '晚安'), m('assistant', -99, '晚安'), m('assistant', -50, '人呢'), m('user', -0.1, '我回来了')];
        const grievance = grievanceNow(history);
        assert.ok(grievance);
        assert.equal(grievance.cause, undefined);
        assert.ok(!describeGrievance(grievance).includes('他到现在才看到你前面发的'));
    });
});
