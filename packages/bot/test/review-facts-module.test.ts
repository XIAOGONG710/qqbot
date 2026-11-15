import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { reviewStage, type Module, type ReviewCtx, type ReviewScratch, type Turn } from '../src/interpreter/interpreter.ts';
import { auditRules, factRewriteNote, type FactClaim, type FactRecord } from '../src/language/fact-check.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { reviewFactsModule, type ReviewFactsOptions } from '../src/modules/review-facts.ts';
import { reviewFinalizeModule } from '../src/modules/review-finalize.ts';
import { reviewUnfinishedModule } from '../src/modules/review-unfinished.ts';
import { createContactResponder, type ContactPipelineOptions } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 逐条事实检查（ADR 0336「生成之后那一段」第 7 步；ADR 0137 / 0203）：只用合成数据、假模型
type FactsCtx = ReviewCtx;
type FactsScratch = ReviewScratch;

const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts: {} };
const crisisTurn: Turn = { ...turn, facts: { crisis: { match: '不想活', level: 'high' } } };
const SOURCE: OpenAIMessage[] = [
    { role: 'system', content: '你是测试角色，正在用 QQ 和阿明私聊。她此刻在宿舍逛淘宝，猫今天没下楼。' },
    { role: 'user', content: '你在干嘛' },
];
const NAMES = { user: '阿明', char: '小测' };

const json = (claims: object[]) => JSON.stringify(claims);
const claim = (quote: string, kind: FactClaim['kind'] = 'invented', why = '事实里没有') => ({ quote, kind, why });
/** 审稿提示词里「她准备发出去的回复」那一段 */
const replyIn = (messages: OpenAIMessage[]) => messages[1]!.content.split('## 她准备发出去的回复\n')[1]!;

/** 假审稿：回复里出现这些片段就算没依据 */
function auditor(bad: readonly string[]) {
    const calls: { messages: OpenAIMessage[]; log: (line: string) => void }[] = [];
    const audit: ReviewFactsOptions['audit'] = async (messages, log) => {
        calls.push({ messages, log });
        const reply = replyIn(messages);
        return json(bad.filter(quote => reply.includes(quote)).map(quote => claim(quote)));
    };
    return { audit, calls, replies: () => calls.map(call => replyIn(call.messages)) };
}

function ctxWith(rewrite: string | Error = '在逛淘宝呢', extra: Partial<FactsCtx> = {}) {
    const notes: string[] = [];
    const logs: string[] = [];
    let accepted = 0;
    const log = (line: string) => { logs.push(line); };
    const ctx: FactsCtx = {
        regenerate: async note => { notes.push(note); if (rewrite instanceof Error) throw rewrite; return rewrite; },
        accept: () => { accepted++; },
        dropDevices: () => {},
        scratch: {},
        log,
        promptSource: SOURCE,
        names: NAMES,
        ...extra,
    };
    return { ctx: ctx as ReviewCtx, notes, logs, log, accepted: () => accepted, scratch: () => ctx.scratch as FactsScratch };
}

const stagesOf = (options: ReviewFactsOptions) => {
    const at = reviewFactsModule(options).reviewAt!;
    return { facts: at.facts!, factsFinal: at.factsFinal! };
};

describe('事实检查模块（ADR 0336）', () => {
    test('只挂在 facts 和 factsFinal 两个位置', () => {
        assert.deepEqual(Object.keys(reviewFactsModule({ mode: 'fix', audit: async () => '[]' }).reviewAt!).sort(), ['facts', 'factsFinal']);
    });

    test('危机回合、固定说法（allowRepeat）、拿不到这一轮的提示词：同步原样返回，不审稿，不记第一次查完的稿子', () => {
        const a = auditor(['撒腿就跑']);
        const { facts } = stagesOf({ mode: 'fix', audit: a.audit });
        const draft = '在刷手机呢\n团子饼一见我撒腿就跑';
        for (const [label, t, s] of [
            ['危机', crisisTurn, ctxWith()],
            ['allowRepeat', turn, ctxWith('x', { allowRepeat: true })],
            ['没有 promptSource', turn, ctxWith('x', { promptSource: undefined })],
            ['没有 names', turn, ctxWith('x', { names: undefined })],
        ] as const) {
            assert.equal(facts(draft, t, s.ctx), draft, label);
            assert.equal(s.scratch().factsChecked, undefined, label);
        }
        assert.equal(a.calls.length, 0);
    });

    test('没问题：审稿一次（设定和事实、聊天按名字、她要发的回复），原样返回、记下第一次查完的稿子；审稿拿到的日志是 ctx.log', async () => {
        const a = auditor([]);
        const s = ctxWith();
        const out = stagesOf({ mode: 'fix', audit: a.audit }).facts('在逛淘宝呢\n刚看中一件外套', turn, s.ctx);
        assert.ok(out instanceof Promise, '要查时返回 promise（同原来 await）');
        assert.equal(await out, '在逛淘宝呢\n刚看中一件外套');
        assert.equal(a.calls.length, 1);
        const [system, user] = a.calls[0]!.messages;
        assert.equal(system!.content, auditRules(false));
        assert.match(user!.content, /她此刻在宿舍逛淘宝/);
        assert.match(user!.content, /阿明：你在干嘛/);
        assert.equal(replyIn(a.calls[0]!.messages), '在逛淘宝呢\n刚看中一件外套');
        assert.equal(a.calls[0]!.log, s.log);
        assert.equal(s.scratch().factsChecked, '在逛淘宝呢\n刚看中一件外套');
        assert.deepEqual(s.notes, []);
    });

    test('太短的回复（不到 6 个字）：不审稿，原样返回（仍记下第一次查完的稿子）', async () => {
        const a = auditor(['嗯嗯']);
        const s = ctxWith();
        assert.equal(await stagesOf({ mode: 'fix', audit: a.audit }).facts('嗯嗯好的', turn, s.ctx), '嗯嗯好的');
        assert.equal(a.calls.length, 0);
        assert.equal(s.scratch().factsChecked, '嗯嗯好的');
    });

    test('fix：带说明重写一次、采用重写（ctx.accept），重写后再查一次通过', async () => {
        const a = auditor(['撒腿就跑']);
        const s = ctxWith('在刷手机呢，你呢');
        const out = await stagesOf({ mode: 'fix', audit: a.audit }).facts('在刷手机呢\n团子饼一见我撒腿就跑', turn, s.ctx);
        assert.equal(out, '在刷手机呢，你呢');
        assert.deepEqual(s.notes, [factRewriteNote([claim('撒腿就跑')])]);
        assert.equal(s.accepted(), 1);
        assert.deepEqual(a.replies(), ['在刷手机呢\n团子饼一见我撒腿就跑', '在刷手机呢，你呢']);
        assert.equal(s.scratch().factsChecked, '在刷手机呢，你呢');
        assert.ok(s.logs.includes('事实检查：重写后通过'), s.logs.join('|'));
    });

    test('fix：重写后仍有就删掉那几行', async () => {
        const a = auditor(['班主任', '辅导员']);
        const s = ctxWith('麻辣香锅\n还碰到了辅导员');
        assert.equal(await stagesOf({ mode: 'fix', audit: a.audit }).facts('麻辣香锅\n还碰到了班主任', turn, s.ctx), '麻辣香锅');
        assert.equal(a.calls.length, 2);
        assert.equal(s.scratch().factsChecked, '麻辣香锅');
    });

    test('主动找他（initiating）：重写后删完剩下的撑不住这一轮——返回空串并 stop；不是主动找他时只删行', async () => {
        const draft = '回来啦\n衣服上落了一只小猫\n楼下阿姨还帮我收了被子';
        const rewrite = '回来啦\n收衣服的时候碰到了宿管\n她还夸我衣服好看';
        const bad = ['小猫', '阿姨', '宿管', '夸我'];
        const a = auditor(bad);
        const s = ctxWith(rewrite, { initiating: true });
        assert.deepEqual(await stagesOf({ mode: 'fix', audit: a.audit }).facts(draft, turn, s.ctx), { text: '', stop: true });
        assert.equal(a.calls.length, 2);
        assert.equal(s.scratch().factsChecked, '');

        const b = auditor(bad);
        const r = ctxWith(rewrite);
        assert.equal(await stagesOf({ mode: 'fix', audit: b.audit }).facts(draft, turn, r.ctx), '回来啦');
    });

    test('经审稿位置跑：stop 一路带出来（reviewStage 返回 { text: "", stop: true }，同一位置后面的模块不跑）', async () => {
        const a = auditor(['小猫', '阿姨', '宿管', '夸我']);
        const s = ctxWith('回来啦\n收衣服的时候碰到了宿管\n她还夸我衣服好看', { initiating: true });
        const after: string[] = [];
        const probe: Module = { id: 'probe', reviewAt: { facts: text => { after.push(text); return text; } } };
        const verdict = await reviewStage([reviewFactsModule({ mode: 'fix', audit: a.audit }), probe], 'facts', '回来啦\n衣服上落了一只小猫\n楼下阿姨还帮我收了被子', turn, s.ctx);
        assert.deepEqual(verdict, { text: '', stop: true });
        assert.deepEqual(after, []);
    });

    test('稿子本来就是空的：查完还是空的也不 stop（同原来 reply 为空时照常往下走）', async () => {
        const a = auditor([]);
        const s = ctxWith('x', { initiating: true });
        assert.equal(await stagesOf({ mode: 'fix', audit: a.audit }).facts('', turn, s.ctx), '');
        assert.equal(a.calls.length, 0);
    });

    test('log：只查只记，不重写，照发', async () => {
        const a = auditor(['撒腿就跑']);
        const s = ctxWith();
        assert.equal(await stagesOf({ mode: 'log', audit: a.audit }).facts('在刷手机呢\n团子饼一见我撒腿就跑', turn, s.ctx), '在刷手机呢\n团子饼一见我撒腿就跑');
        assert.equal(a.calls.length, 1);
        assert.deepEqual(s.notes, []);
        assert.equal(s.accepted(), 0);
        assert.ok(s.logs.some(line => line.includes('只记录，照发')), s.logs.join('|'));
    });

    test('aboutHim：审稿的规则多一类「替他说的」，重写说明带「别替他说」；不开时审稿员说的 about-him 不采信', async () => {
        const audit = async (messages: OpenAIMessage[]) => (replyIn(messages).includes('你数学不差') ? json([claim('你数学不差', 'about-him', '他没说过')]) : '[]');
        const seen: string[] = [];
        const on = ctxWith('我觉得你先想清楚是不是真想读');
        assert.equal(await stagesOf({ mode: 'fix', aboutHim: true, audit: async m => { seen.push(m[0]!.content); return audit(m); } }).facts('你数学不差，真去考不会差的', turn, on.ctx), '我觉得你先想清楚是不是真想读');
        assert.equal(seen[0], auditRules(true));
        assert.match(on.notes[0]!, /别替他说他没说过的事/);

        const off = ctxWith('不该重写');
        assert.equal(await stagesOf({ mode: 'fix', audit: async m => { seen.push(m[0]!.content); return audit(m); } }).facts('你数学不差，真去考不会差的', turn, off.ctx), '你数学不差，真去考不会差的');
        assert.equal(seen.at(-1), auditRules(false));
        assert.deepEqual(off.notes, []);
    });

    test('onRecord：每次检查的记录都交出去（模拟器的报告）', async () => {
        const records: FactRecord[] = [];
        const a = auditor(['撒腿就跑']);
        const s = ctxWith('在刷手机呢，你呢');
        await stagesOf({ mode: 'fix', audit: a.audit, onRecord: record => { records.push(record); } }).facts('在刷手机呢\n团子饼一见我撒腿就跑', turn, s.ctx);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.action, 'rewritten');
        assert.equal(records[0]!.rewritten, '在刷手机呢，你呢');
    });

    test('审稿出错：照发，不往外抛', async () => {
        const s = ctxWith();
        const out = await stagesOf({ mode: 'fix', audit: async () => { throw new Error('模型挂了'); } }).facts('在刷手机呢\n团子饼一见我撒腿就跑', turn, s.ctx);
        assert.equal(out, '在刷手机呢\n团子饼一见我撒腿就跑');
        assert.ok(s.logs.some(line => line.includes('没查成')), s.logs.join('|'));
    });
});

describe('事实检查模块的最后一查（factsFinal）', () => {
    test('第一次没查（scratch 里没有）：同步原样返回', () => {
        const a = auditor(['大雪']);
        const s = ctxWith();
        assert.equal(stagesOf({ mode: 'fix', audit: a.audit }).factsFinal('那天还下了大雪呢真的', turn, s.ctx), '那天还下了大雪呢真的');
        assert.equal(a.calls.length, 0);
    });

    test('稿子和第一次查完的一样：同步原样返回，不再审稿', () => {
        const a = auditor(['大雪']);
        const s = ctxWith();
        s.scratch().factsChecked = '那天还下了大雪呢真的';
        assert.equal(stagesOf({ mode: 'fix', audit: a.audit }).factsFinal('那天还下了大雪呢真的', turn, s.ctx), '那天还下了大雪呢真的');
        assert.equal(a.calls.length, 0);
    });

    test('后面几步改过：再查一次，只删行、不重写（finalOnly）', async () => {
        const a = auditor(['大雪']);
        const s = ctxWith('不该重写');
        s.scratch().factsChecked = '<<查：第一次约会的地方>>\n我想想';
        const out = stagesOf({ mode: 'fix', audit: a.audit }).factsFinal('记得呀\n学校后门那家火锅店\n那天还下了大雪', turn, s.ctx);
        assert.ok(out instanceof Promise);
        assert.equal(await out, '记得呀\n学校后门那家火锅店');
        assert.equal(a.calls.length, 1);
        assert.deepEqual(s.notes, []);
        assert.equal(s.accepted(), 0);
        assert.ok(s.logs.some(line => line.includes('最后一次核对，删掉有问题的行')), s.logs.join('|'));
    });

    test('最后一查不整条删光：主动找他时删完撑不住也只删行，不 stop', async () => {
        const a = auditor(['小猫', '阿姨']);
        const s = ctxWith('x', { initiating: true });
        s.scratch().factsChecked = '回来啦';
        assert.equal(await stagesOf({ mode: 'fix', audit: a.audit }).factsFinal('回来啦\n衣服上落了一只小猫\n楼下阿姨还帮我收了被子', turn, s.ctx), '回来啦');
    });

    test('改过、但太短不值得查：不审稿，原样返回', async () => {
        const a = auditor(['找找']);
        const s = ctxWith();
        s.scratch().factsChecked = '<<查：借书>>\n我找找哈';
        assert.equal(await stagesOf({ mode: 'fix', audit: a.audit }).factsFinal('我找找哈', turn, s.ctx), '我找找哈');
        assert.equal(a.calls.length, 0);
    });
});

const WIRED = true;

describe('联系人流水线里的事实检查', { skip: !WIRED && '等接线（ADR 0336 第 7 步）' }, () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    function pipeline(generate: (messages: OpenAIMessage[]) => string, bad: readonly string[], overrides: Partial<ContactPipelineOptions> = {}, modules: readonly Module[] = []) {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const a = auditor(bad);
        const exits: string[] = [];
        const probe: Module = { id: 'probe-exit', reviewAt: { exit: text => { exits.push(text); return text; } } };
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewFactsModule({ mode: 'fix', audit: a.audit }), reviewFinalizeModule(), ...modules, probe],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async messages => generate(messages),
            ...overrides,
        });
        return {
            a, sent, exits, responder,
            async say(text: string) {
                try { responder.receive(text, 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
            },
        };
    }
    const rewriting = (first: string, rewrite: string) => (messages: OpenAIMessage[]) => (messages.at(-1)!.content.includes('上一版回复没有发出去') ? rewrite : first);

    test('编了小动作：带说明重写，发出去的是重写的；审稿看到的聊天按名字（小明：…）', async () => {
        const p = pipeline(rewriting('在刷手机呢\n团子饼一见我撒腿就跑', '在刷手机呢，你呢'), ['撒腿就跑']);
        await p.say('你在干嘛');
        assert.deepEqual(p.sent, ['在刷手机呢，你呢']);
        assert.equal(p.a.calls.length, 2);
        assert.match(p.a.calls[0]!.messages[1]!.content, /小明：你在干嘛/);
    });

    test('后面一步的重写带进来新的编的事：最后一查删掉那一行（不再重写）', async () => {
        let calls = 0;
        const p = pipeline(() => (++calls === 1 ? '我知道你在说什么了\n不过你别得意' : '猫刚跑到楼下去了\n我知道你在说什么了'), ['猫刚跑到楼下去了'], { speechCheck: true }, [reviewUnfinishedModule()]);
        await p.say('今天心情不错');
        assert.equal(calls, 2);
        assert.equal(p.a.calls.length, 2);
        assert.ok(p.sent.length > 0 && p.sent.every(text => !text.includes('猫')), p.sent.join('|'));
    });

    test('主动找他、删完撑不住：这一轮到此为止（出口检查那个位置都不跑），按「生成的是空的」不发', async () => {
        const p = pipeline(rewriting('回来啦\n衣服上落了一只小猫\n楼下阿姨还帮我收了被子', '回来啦\n收衣服的时候碰到了宿管\n她还夸我衣服好看'), ['小猫', '阿姨', '宿管', '夸我']);
        try {
            const outcome = await p.responder.initiate({ label: '测试', note: '你想主动找他说两句', topic: '他最近在忙什么', maxBubbles: 3, dryRun: true, commit: () => {} });
            assert.deepEqual(outcome, { result: 'skipped', reason: '生成的是空的' });
        } finally { p.responder.stop(); }
        assert.equal(p.a.calls.length, 2);
        assert.deepEqual(p.exits, []);
    });

    test('固定说法（allowRepeat）的主动消息：不查', async () => {
        const p = pipeline(() => '回来啦\n衣服上落了一只小猫', ['小猫']);
        try {
            const outcome = await p.responder.initiate({ label: '测试', note: '你想主动找他说两句', topic: '他最近在忙什么', maxBubbles: 3, dryRun: true, commit: () => {}, allowRepeat: true });
            assert.equal(outcome.result, 'dryRun');
        } finally { p.responder.stop(); }
        assert.equal(p.a.calls.length, 0);
    });

    test('危机回合不查', async () => {
        const p = pipeline(() => '我在\n你现在安全吗', ['安全']);
        await p.say('我不想活了，真的撑不下去了');
        assert.equal(p.a.calls.length, 0);
    });
});
