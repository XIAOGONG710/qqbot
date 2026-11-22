import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../src/platform/config.ts';
import { EXPRESSION_WINDOW_MS, groupOpportunity, motiveAllows, opportunityOpen, type GroupMotiveDecision } from '../src/social/group-opportunity.ts';
import { speakReason, type SpeakContext, type SpeakDecision } from '../src/social/group-chat.ts';
import { chimePlan, crossesHerLine, defendCall, defendWishFrom, teasesHim } from '../src/social/group-self.ts';
import type { AgencyShadow } from '../src/world/agency-shadow.ts';
import type { GroupEntry } from '../src/social/group-chat.ts';
import { runGroupScenario, type GroupScenario } from '../src/sim/group-runner.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 群自主（ADR 0343）：默认关，off 逐字基线；on 时主动开口由影子动机决定，抽签退位。
const SELF = 20000;
const HOUR = 3_600_000;
const allowed: GroupMotiveDecision = { eligible: true, blocks: [], reason: '可交给她判断', driveId: 'drive:test', score: 0.8 };
const blocked: GroupMotiveDecision = { eligible: false, blocks: ['low_mood'], reason: '低落，先不说', driveId: 'drive:test', score: 0.8 };
const ctx = (): SpeakContext => ({ selfId: SELF, herMessageIds: new Set([7001]), topicToday: 0, overheardToday: 0 });
const text = (value: string) => ({ type: 'text', data: { text: value } });

const SHADOW_AT = '2026-11-20T12:00:00';
function shadowWith(opportunities: () => { driveId: string; eligible: boolean; blocks: readonly never[]; reason: string }[], scores: Record<string, number>,
    decidedAt: Record<string, string> = {}, expiresAt: Record<string, string> = {}): AgencyShadow {
    const fallback = new Date(Date.parse(SHADOW_AT) - 10 * 60_000).toISOString();
    return {
        opportunities: { opportunities },
        decisions: { decisions: () => Object.entries(scores).map(([driveId, score]) => ({ id: `decision:${driveId}`, driveId, score, outcome: 'focus', decidedAt: decidedAt[driveId] ?? fallback, reason: '测试' })) },
        motivations: { drives: () => Object.entries(expiresAt).map(([id, expires]) => ({ id, expiresAt: expires })) },
    } as unknown as AgencyShadow;
}

describe('群自主：影子账投影', () => {
    test('取分数最高的可表达机会；没账 / 没有机会 / 读账出错都按潜水', () => {
        const at = new Date(SHADOW_AT);
        const shadow = shadowWith(() => [
            { driveId: 'low', eligible: true, blocks: [], reason: '低分' },
            { driveId: 'high', eligible: true, blocks: [], reason: '高分' },
            { driveId: 'blocked', eligible: false, blocks: [], reason: '拦下' },
        ], { low: 0.3, high: 0.9, blocked: 1 });
        const decision = groupOpportunity(at, shadow);
        assert.equal(decision.eligible, true);
        assert.equal(decision.driveId, 'high');
        assert.equal(decision.score, 0.9);
        assert.equal(motiveAllows(decision), true);
        assert.equal(groupOpportunity(at, undefined).eligible, false);
        assert.equal(groupOpportunity(at, shadowWith(() => [], {})).eligible, false);
        const broken = shadowWith(() => { throw new Error('账坏了'); }, {});
        assert.equal(groupOpportunity(at, broken).eligible, false, '异常吞掉');
        assert.equal(motiveAllows(blocked), false);
        assert.equal(motiveAllows({ eligible: true, blocks: [], reason: '没给分数', score: 0.1 }), false, '分数不够不放行');
    });

    // groupAgency A（用户 2026-11-22 选「加时间窗」）：原来账里一条 eligible 写进去就永远放行
    test('只认此刻还在时间窗里的机会：从那次裁决起一小时，动机更早过期就到那时；还没裁决、裁决在以后、找不到裁决的都不算', () => {
        const at = new Date(SHADOW_AT);
        const iso = (offsetMin: number) => new Date(at.getTime() + offsetMin * 60_000).toISOString();
        const opp = (driveId: string) => ({ driveId, eligible: true, blocks: [] as never[], reason: driveId });
        const closed = shadowWith(() => [opp('old'), opp('future'), opp('edge'), opp('expired'), opp('orphan')],
            { old: 1, future: 1, edge: 1, expired: 1 },
            { old: iso(-90), future: iso(5), edge: iso(-60), expired: iso(-10) },
            { expired: iso(-1) });
        assert.equal(groupOpportunity(at, closed).eligible, false, JSON.stringify(groupOpportunity(at, closed)));
        const open = shadowWith(() => [opp('old'), opp('fresh')], { old: 1, fresh: 0.5 }, { old: iso(-90), fresh: iso(-59) });
        assert.equal(groupOpportunity(at, open).driveId, 'fresh');
        assert.equal(EXPRESSION_WINDOW_MS, 3_600_000);
        assert.equal(opportunityOpen(iso(0), undefined, at.getTime()), true);
        assert.equal(opportunityOpen(undefined, undefined, at.getTime()), false);
        assert.equal(opportunityOpen('坏', undefined, at.getTime()), false);
    });
});

describe('群自主：speakReason 的 source 与抽签退位', () => {
    test('不传 motives（off）：逐字走原抽签，主动理由是 lottery，被叫 / 危机 / 替他说总是 reactive', () => {
        const observations: SpeakDecision[] = [];
        const id = 6000; // 原来的签 709，30% 抽不中
        assert.equal(speakReason([text('晚上吃火锅吗')], '晚上吃火锅吗', 30001, id, ctx(), { onDecision: d => observations.push(d) }), undefined);
        assert.equal(observations.at(-1)!.source, 'lottery');
        assert.equal(speakReason([{ type: 'at', data: { qq: String(SELF) } }, text(' 你说呢')], '@你 你说呢', 30001, id, ctx(), { onDecision: d => observations.push(d) }), 'mentioned');
        assert.equal(observations.at(-1)!.source, 'reactive');
        assert.equal(speakReason([text('真的不想活了')], '真的不想活了', 30001, id, ctx(), { onDecision: d => observations.push(d) }), 'crisis');
        assert.equal(observations.at(-1)!.source, 'reactive');
    });

    test('on + eligible：原来抽不中的编号也开口，source=motive；on + ineligible：原来抽得中的也潜水', () => {
        const miss = 6000; // off 时抽不中
        const hit = 6102; // off 时抽得中
        const seen: SpeakDecision[] = [];
        const on = (motives: GroupMotiveDecision) => ({ motives, onDecision: (d: SpeakDecision) => seen.push(d) });
        assert.equal(speakReason([text('晚上吃火锅吗')], '晚上吃火锅吗', 30001, miss, ctx(), on(allowed)), 'topic');
        assert.equal(seen.at(-1)!.source, 'motive');
        assert.equal(seen.at(-1)!.motiveEligible, true);
        assert.equal(speakReason([text('晚上吃火锅吗')], '晚上吃火锅吗', 30001, hit, ctx(), on(blocked)), undefined);
        assert.equal(seen.at(-1)!.source, 'motive');
        assert.equal(seen.at(-1)!.motiveEligible, false);
    });
});

describe('群自主：chimePlan 时机不动，只换末尾那道判定', () => {
    const now = Date.parse('2026-11-20T16:00:00');
    const lively = (at: number): GroupEntry[] => Array.from({ length: 6 }, (_, i) => ({
        time: new Date(at - 5 * HOUR - (5 - i) * 60_000).toISOString(), from: 30001 + (i % 2), name: `群友${i}`, content: `闲聊 ${i}`, messageId: i,
    }));
    test('冷场：抽不中的整点，动机放行就冒；动机拦下就潜水', () => {
        let missed = -1;
        for (let h = 0; h < 96; h++) {
            const at = now + h * HOUR;
            if (chimePlan({ groupId: 555, entries: lively(at), now: at, free: true, done: { quiet: 0, news: 0 } }) === undefined) { missed = h; break; }
        }
        assert.ok(missed >= 0, '总有一个抽不中的整点');
        const at = now + missed * HOUR;
        const input = { groupId: 555, entries: lively(at), now: at, free: true, done: { quiet: 0, news: 0 } };
        assert.equal(chimePlan(input, { motives: allowed })?.kind, 'quiet');
        assert.equal(chimePlan(input, { motives: blocked }), undefined);
        // 时机条件照旧：不自由就不冒，哪怕动机放行
        assert.equal(chimePlan({ ...input, free: false }, { motives: allowed }), undefined);
    });
});

describe('群自主：她定的边界（ADR 0343 原话）', () => {
    test('分数排名、咱俩的事、起哄问咱俩、多穿点式关心越线；她喂的猫和替陌生人讲公道话不越', () => {
        assert.equal(crossesHerLine('这次排名第 3'), 'study');
        assert.equal(crossesHerLine('我男朋友昨天来找我'), 'us');
        assert.equal(crossesHerLine('你俩啥时候在一起的'), 'tease');
        assert.equal(crossesHerLine('今天冷了，多穿点'), 'care');
        assert.equal(crossesHerLine('我下楼喂了猫，还拍了它'), undefined);
        assert.equal(crossesHerLine('替他说句公道话，这事本来就不对'), undefined);
    });
});

// ── 模拟器上的端到端（构造 eligible 且消息编号使 pick 必不中） ──
const base = {
    llm: { baseUrl: 'http://127.0.0.1:9', model: 'sim-test', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi' as const, extraBody: {} },
    prompt: { ...DEFAULTS.prompt, maxContext: 16384, pinExamples: true } as never,
};
const topicScenario = (say: string): GroupScenario => ({
    about: '合成：聊到她熟的，没人叫她', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王'],
    steps: [{ from: '老王', say, pause: 0.1 }],
});
const options = (extra: Record<string, unknown> = {}) => ({ base, characterCard: syntheticCardPattern, idleMs: 2500, maxWaitMs: 15_000, generate: async () => '我喝过，芋泥那款还行', ...extra });

describe('群自主：模拟端到端', () => {
    test('on 无 lottery：on + 动机没放行，原来抽得中的编号也不开口，痕迹全是 motive', async () => {
        const run = await runGroupScenario(topicScenario('学校门口新开了家奶茶店，好喝吗'), options({
            base: { ...base, groupAgency: 'on' }, firstMessageId: 6102, // off 时抽得中
        }));
        assert.equal(run.spoke, 0, run.logs.join('\n'));
        assert.ok(run.decisions.length > 0, '决策痕迹有收集到');
        assert.ok(run.decisions.every(decision => decision.source === 'motive'), JSON.stringify(run.decisions));
    });

    test('on + eligible：原来抽不中的编号也开口，模型写「不说」不翻 passed', async () => {
        const run = await runGroupScenario(topicScenario('学校门口新开了家奶茶店，好喝吗'), options({
            motiveOverride: allowed, firstMessageId: 6000, // off 时抽不中
        }));
        assert.equal(run.spoke, 1, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { topic: 1 });
        const decision = run.decisions.find(item => item.reason === 'topic')!;
        assert.equal(decision.source, 'motive');
        assert.equal(decision.passed, true);
    });

    test('三边界越线：分数排名 / 咱俩的事 / 起哄问咱俩 / 多穿点，passed=false 且 blockedBy=line', async () => {
        // 合成卡把「男朋友」列为禁用词（会被出口检查先拦），所以「咱俩的事」用「我们俩」构造越线样本
        for (const reply of ['这次排名第 3', '我们俩周末去看电影', '你俩啥时候在一起的', '今天冷了多穿点']) {
            const run = await runGroupScenario(topicScenario('学校门口新开了家奶茶店，好喝吗'), options({
                motiveOverride: allowed, firstMessageId: 6000, generate: async () => reply,
            }));
            assert.equal(run.spoke, 0, `${reply}：${run.logs.join('\n')}`);
            assert.ok(run.decisions.some(decision => decision.passed === false && decision.blockedBy === 'line'), reply);
        }
    });

    test('危机轮不吞：on 时劝人的话带「挂科」「成绩」也照发', async () => {
        const scenario: GroupScenario = {
            about: '合成：有人想不开', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王'],
            steps: [{ from: '老王', say: '挂科了，真的不想活了', pause: 0.1 }],
        };
        const reply = '挂科真的不算什么 成绩以后能补回来 你先别想不开 我陪你说说';
        const run = await runGroupScenario(scenario, options({ motiveOverride: blocked, generate: async () => reply }));
        assert.deepEqual(run.lines.filter(line => line.mine).map(line => line.text), [reply], run.logs.join('\n'));
        assert.equal(run.reasons.crisis, 1);
        assert.ok(run.decisions.some(decision => decision.reason === 'crisis' && decision.source === 'reactive'));
    });

    test('called：四次叫她接四次，全是 mentioned、source=reactive（动机不参与）', async () => {
        const scenario: GroupScenario = {
            about: '合成：四次叫她', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王'],
            steps: Array.from({ length: 4 }, () => ({ from: '老王', say: '梦瑶在吗', atHer: true, pause: 2 })),
        };
        const run = await runGroupScenario(scenario, options({ motiveOverride: blocked, idleMs: 2500, maxWaitMs: 30_000 }));
        assert.equal(run.spoke, 4, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { mentioned: 4 });
        assert.equal(run.decisions.filter(decision => decision.reason === 'mentioned').length, 4);
        assert.ok(run.decisions.filter(decision => decision.reason === 'mentioned').every(decision => decision.source === 'reactive'));
    });

    test('dryRun 只把动机放行的那句写草稿：被叫照常发出去（不能因为开了 dryRun 就不理 @ 她的人）', async () => {
        const scenario: GroupScenario = {
            about: '合成：dryRun 下叫她', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王'],
            steps: [{ from: '老王', say: '梦瑶在吗', atHer: true, pause: 0.1 }],
        };
        const run = await runGroupScenario(scenario, options({ base: { ...base, groupAgency: 'dryRun' }, motiveOverride: blocked }));
        assert.equal(run.spoke, 1, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { mentioned: 1 });
    });

    test('dryRun + 动机放行：主动那句只写草稿，不发', async () => {
        const run = await runGroupScenario(topicScenario('学校门口新开了家奶茶店，好喝吗'), options({
            base: { ...base, groupAgency: 'dryRun' }, motiveOverride: allowed, firstMessageId: 6000,
        }));
        assert.equal(run.spoke, 0, run.logs.join('\n'));
        assert.ok(run.decisions.some(decision => decision.reason === 'topic' && decision.passed), JSON.stringify(run.decisions));
    });

    test('她定的线只看叫她开口的那条：同一批里别人提了句「成绩」，有人 @ 她问别的照样接', async () => {
        const scenario: GroupScenario = {
            about: '合成：一批里有人说成绩，另一个人叫她', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王', '陈陈'],
            steps: [
                { from: '老王', say: '期中成绩出来了', pause: 0.1 },
                { from: '陈陈', say: '晚上吃饭去不去', atHer: true, pause: 0.1 },
            ],
        };
        const run = await runGroupScenario(scenario, options({ motiveOverride: blocked, generate: async () => '去啊，几点' }));
        assert.equal(run.spoke, 1, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { mentioned: 1 });
    });
});


// groupAgency B：有人损他，她出不出头按她 2026-11-22 的三档（ADR 0343「她的三档」）
describe('群自主：有人损他，她的三档', () => {
    const now = Date.parse('2026-11-20T16:00:00');
    const t = (minAgo: number) => now - minAgo * 60_000;
    test('随口玩笑的损不管；难听的、或者十分钟内两个人以上一起损才出头；他说过不要就不出头', () => {
        assert.deepEqual(defendCall({ teasing: [{ from: 1, text: '阿明这把也太菜了', at: t(1) }], now }).defend, false);
        assert.equal(defendCall({ teasing: [{ from: 1, text: '阿明你个废物', at: t(1) }], now }).defend, true);
        assert.equal(defendCall({ teasing: [{ from: 1, text: '阿明菜', at: t(3) }, { from: 2, text: '阿明就这', at: t(1) }], now }).why, '一群人围着挤兑他一个');
        assert.equal(defendCall({ teasing: [{ from: 1, text: '阿明菜', at: t(3) }, { from: 1, text: '阿明就这', at: t(1) }], now }).defend, false, '同一个人说两句不算围攻');
        assert.equal(defendCall({ teasing: [{ from: 1, text: '阿明菜', at: t(30) }, { from: 2, text: '阿明就这', at: t(1) }], now }).defend, false, '半小时前那句不算这一阵');
        assert.equal(defendCall({ teasing: [{ from: 1, text: '阿明你个废物', at: t(1) }], now, wish: 'no' }).defend, false);
        assert.equal(teasesHim('阿明滚蛋', ['阿明']), true, '难听的话也算损他');
        assert.equal(teasesHim('阿明明天来吗', ['阿明']), false);
    });
    test('他的意思看私聊里最近那句：说过不要就是 no，后来又说要就是 yes', () => {
        const said = (...lines: string[]) => lines.map(content => ({ role: 'user', content }));
        assert.equal(defendWishFrom(said('今天好累')), undefined);
        assert.equal(defendWishFrom(said('群里有人损我你别帮我说话')), 'no');
        assert.equal(defendWishFrom(said('不用你替我出头')), 'no');
        assert.equal(defendWishFrom(said('不用你替我出头', '算了，群里有人损我你就帮我说话吧')), 'yes');
        assert.equal(defendWishFrom([{ role: 'assistant', content: '群里别帮我说话' }]), undefined, '她自己说的不算');
    });
    // 他先在群里说过话（群名片认得出他）、隔开一批，后面的人再叫他的名字损他
    const tease = (steps: GroupScenario['steps']): GroupScenario => ({ about: '合成：有人损他', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王', '陈陈'], steps: [{ from: '阿明', say: '这把输了', pause: 2 }, ...steps] });
    test('模拟器：一个人随口损一句她不出头；一个人骂得难听她出头', async () => {
        const mild = await runGroupScenario(tease([{ from: '老王', say: '阿明这把打得也太菜了', pause: 0.1 }]), options({ motiveOverride: blocked, generate: async () => '人家好着呢' }));
        assert.equal(mild.spoke, 0, mild.logs.join('\n'));
        assert.ok(mild.logs.some(line => line.includes('随口开玩笑的损')), mild.logs.join('\n'));
        const harsh = await runGroupScenario(tease([{ from: '老王', say: '阿明你个废物', pause: 0.1 }]), options({ motiveOverride: blocked, generate: async () => '人家好着呢，你行你上' }));
        assert.equal(harsh.spoke, 1, harsh.logs.join('\n'));
        assert.deepEqual(harsh.reasons, { defend: 1 });
    });
    test('模拟器：两个人一起损（都只是斗嘴的词）也出头', async () => {
        const run = await runGroupScenario(tease([
            { from: '老王', say: '阿明这把打得也太菜了', pause: 0.1 },
            { from: '陈陈', say: '阿明就这？', pause: 0.1 },
        ]), options({ motiveOverride: blocked, generate: async () => '人家好着呢，你行你上' }));
        assert.equal(run.spoke, 1, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { defend: 1 });
    });
});
