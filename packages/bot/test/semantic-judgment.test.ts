import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ReviewCtx, Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import type { ChatMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { keywordCareRequest, keywordTopicShift, reviewExitModule } from '../src/modules/review-exit.ts';
import { semanticJudgmentModule, semanticJudgmentOn } from '../src/modules/semantic-judgment.ts';
import { buildTurnModules, type TurnModuleDeps } from '../src/platform/turn-modules.ts';
import {
    JUDGMENT_CONTEXT, JUDGMENT_MAX_UNCERTAINTY, judgeTurn, judgmentConversation, judgmentLine, judgmentLogLine, judgmentMessages, parseJudgment,
    type JudgmentAsk, type JudgmentCategory, type JudgmentMessage,
} from '../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';

// 私聊语义判断（硬编码改造第一优先级）：只用合成对话、假模型（按剧本回 JSON），不调真模型

const said = (...lines: string[]): ChatMessage[] => lines.map((content, i) => ({ role: (lines.length - i) % 2 === 1 ? 'user' : 'assistant', content }));
const user = (content: string): ChatMessage => ({ role: 'user', content });
const her = (content: string): ChatMessage => ({ role: 'assistant', content });

/** 按剧本回的假模型：quotes 里每一段在给它的对话里找到所在的行（先从他最后那几行找） */
function scripted(category: JudgmentCategory, uncertainty: number, quotes: string[] = []): JudgmentAsk & { calls: JudgmentMessage[][] } {
    const calls: JudgmentMessage[][] = [];
    const ask = async (messages: JudgmentMessage[]) => {
        calls.push(messages);
        const numbered = messages[1]!.content.split('\n').map(line => /^(\d+) [他她]：(.*)$/u.exec(line)).filter(Boolean) as RegExpExecArray[];
        const evidence = quotes.map(quote => {
            const hit = [...numbered].reverse().find(m => m[2]!.includes(quote));
            return { line: hit ? Number(hit[1]) : 99, quote };
        });
        return JSON.stringify({ category, evidence, uncertainty });
    };
    return Object.assign(ask, { calls });
}

describe('严格解析（parseJudgment）', () => {
    const conversation = judgmentConversation(said('今天好累', '辛苦啦', '我认真想听你哄我一下。'));
    const ok = { category: 'care', evidence: [{ line: 3, quote: '想听你哄我' }], uncertainty: 0.1 };

    test('合格的回答：类别、依据（说话人按对话定）、不确定性', () => {
        assert.deepEqual(parseJudgment(JSON.stringify(ok), conversation), { category: 'care', evidence: [{ line: 3, speaker: 'him', quote: '想听你哄我' }], uncertainty: 0.1 });
        assert.ok(parseJudgment(`\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``, conversation), '外面一层代码块可以');
        assert.deepEqual(parseJudgment('{"category":"none","evidence":[],"uncertainty":0.2}', conversation)?.category, 'none');
    });

    test('有一样不对就整个不认', () => {
        const bad: unknown[] = [
            `好的：${JSON.stringify(ok)}`, // 前面带话
            '{"category":"care"', // 不是完整 JSON
            JSON.stringify({ ...ok, why: '他累了' }), // 多了字段
            JSON.stringify({ category: 'care', evidence: ok.evidence }), // 少了字段
            JSON.stringify({ ...ok, category: 'comfort' }), // 类别不在清单
            JSON.stringify({ ...ok, uncertainty: 1.5 }), JSON.stringify({ ...ok, uncertainty: '0.1' }),
            JSON.stringify({ ...ok, evidence: [{ line: 3, quote: '想抱抱' }] }), // 原文对不上
            JSON.stringify({ ...ok, evidence: [{ line: 9, quote: '哄我' }] }), // 行号越界
            JSON.stringify({ ...ok, evidence: [{ line: 3, quote: '我认真想听你哄我一下我认真想听你哄我一下我认真想' }] }), // 太长
            JSON.stringify({ ...ok, evidence: [{ line: 3, quote: '哄我', speaker: 'her' }] }), // 依据多了字段
            JSON.stringify({ ...ok, evidence: [{ line: 1, quote: '好累' }] }), // 证据不足：没有一处落在他最后那几行
            JSON.stringify({ ...ok, evidence: [] }),
            42, undefined,
        ];
        for (const raw of bad) assert.equal(parseJudgment(raw, conversation), undefined, String(raw));
    });

    test('对话整理：只留两人说的话、去空白、取最后几条；他最后那几行是第几行写进提示词', () => {
        const long = Array.from({ length: 10 }, (_, i) => (i % 2 ? her(`她 ${i}`) : user(`他 ${i}`)));
        const lines = judgmentConversation([{ role: 'system', content: '设定' }, ...long, user('喂'), { role: 'tool', content: 'x' }, user('  在吗\n\n在吗 '), user('')]);
        assert.equal(lines.length, JUDGMENT_CONTEXT);
        assert.deepEqual(lines.at(-1), { role: 'user', content: '在吗 在吗' });
        const prompt = judgmentMessages(lines);
        assert.equal(prompt[0]!.role, 'system');
        assert.match(prompt[1]!.content, /他刚说的是第 5–6 行/);
    });
});

describe('问一次（judgeTurn）：出错一律退回关键词', () => {
    const conversation = judgmentConversation(said('我认真想听你哄我一下。'));
    test('能用的判断', async () => {
        const result = await judgeTurn({ conversation, ask: scripted('care', 0.1, ['哄我']) });
        assert.equal(result.fallback, undefined);
        assert.equal(result.judgment?.category, 'care');
    });
    test('超时、抛错、读不懂、拿不准、不确定性太高、他没说话', async () => {
        assert.equal((await judgeTurn({ conversation, ask: () => new Promise<string>(() => {}), timeoutMs: 10 })).fallback, 'timeout');
        assert.equal((await judgeTurn({ conversation, ask: async () => { throw new Error('断了'); } })).fallback, 'error');
        assert.equal((await judgeTurn({ conversation, ask: () => { throw new Error('同步抛'); } })).fallback, 'error');
        assert.equal((await judgeTurn({ conversation, ask: async () => '他应该是想被哄' })).fallback, 'unparsable');
        assert.equal((await judgeTurn({ conversation, ask: scripted('unclear', 0.3) })).fallback, 'uncertain');
        const shaky = await judgeTurn({ conversation, ask: scripted('care', JUDGMENT_MAX_UNCERTAINTY + 0.1, ['哄我']) });
        assert.equal(shaky.fallback, 'uncertain');
        assert.equal(shaky.judgment?.category, 'care', '模型给的留着给日志看，但不用');
        let asked = 0;
        assert.equal((await judgeTurn({ conversation: judgmentConversation([user('哈哈'), her('你好笨')]), ask: async () => { asked++; return ''; } })).fallback, 'empty');
        assert.equal(asked, 0, '最后一句是她说的：不问');
    });
});

describe('放给她的那一行和日志', () => {
    test('只说理解和把握；none / 拿不准没有这一行', async () => {
        const conversation = judgmentConversation(said('今天被骂了一天，你能不能好好跟我说两句'));
        const care = (await judgeTurn({ conversation, ask: scripted('care', 0.1, ['好好跟我说两句']) })).judgment;
        assert.equal(judgmentLine(care), '[你对他这几句的理解：他像是认真想让你在意他一下，不是在逗着玩（依据：他说的「好好跟我说两句」；把握：较大）。这只是你的理解，不一定对，以他的原话为准]');
        const banter = (await judgeTurn({ conversation, ask: scripted('banter', 0.4, ['说两句']) })).judgment;
        assert.match(judgmentLine(banter), /轻松接梗.*把握：一般/);
        assert.equal(judgmentLine((await judgeTurn({ conversation, ask: scripted('none', 0.1) })).judgment), '');
        assert.equal(judgmentLine(undefined), '');
    });

    test('日志不记原话、不记账号：只有类别、不确定性、依据条数、字数', async () => {
        const words = '我是 10001，今天被骂了一天，你能不能好好跟我说两句';
        const conversation = judgmentConversation(said(words));
        const lines = [
            judgmentLogLine(await judgeTurn({ conversation, ask: scripted('care', 0.1, ['好好跟我说两句']) }), conversation),
            judgmentLogLine(await judgeTurn({ conversation, ask: async () => '{}' }), conversation),
            judgmentLogLine(await judgeTurn({ conversation, ask: scripted('care', 0.9, ['说两句']) }), conversation),
        ];
        assert.match(lines[0]!, /^语义判断：care（认真求关心），不确定性 0\.1，依据 1 处，他这几句 \d+ 字$/);
        assert.match(lines[1]!, /退回关键词（回答读不懂）/);
        assert.match(lines[2]!, /退回关键词（拿不准，模型给的是 care 0\.9）/);
        for (const line of lines) {
            assert.doesNotMatch(line, /10001|被骂|说两句/);
        }
    });
});

// ── 接进 QQ 的一轮：模块（判断）→ 出口检查（只换「认不认」）──

const turnOf = (history: ChatMessage[], extra: Partial<Turn> = {}, facts: TurnFacts = {}): Turn =>
    ({ contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T22:00:00+08:00'), history, thinking: false, facts, ...extra });

/** 跑模块的 assess → decideAt.deliberate → contribute，返回写下的判断、放的段落、日志 */
async function judgeOnQQ(history: ChatMessage[], ask: JudgmentAsk, extra: Partial<Turn> = {}, facts: TurnFacts = {}) {
    const logs: string[] = [];
    const module = semanticJudgmentModule({ ask, log: line => logs.push(line) });
    const turn = turnOf(history, extra, facts);
    module.assess!(turn);
    await module.decideAt!.deliberate!(turn, { history: () => [], log: () => {} });
    const pieces = await module.contribute!(turn);
    return { turn, judgment: turn.facts.semanticJudgment, pieces, logs };
}

const exit = reviewExitModule().reviewAt!.exit!;
const reviewCtx = (): { ctx: ReviewCtx; rewrites: () => number } => {
    let rewrites = 0;
    return {
        ctx: {
            regenerate: async () => { rewrites++; return '（重写稿）'; }, accept: () => {}, dropDevices: () => {}, scratch: {}, log: () => {},
            exit: { speechCheck: false, imageStickers: false }, history: () => [] as StoredMessage[],
        },
        rewrites: () => rewrites,
    };
};
/** 这一稿过出口检查之后是「照发」还是「重写」 */
async function finalPath(turn: Turn, draft: string): Promise<'照发' | '重写'> {
    const { ctx, rewrites } = reviewCtx();
    const out = await exit(draft, turn, ctx);
    assert.equal(typeof out, 'string');
    return rewrites() ? '重写' : '照发';
}

describe('QQ 模块：只给男朋友档的私聊，能用的才写，判断不当权限', () => {
    test('写进 facts、放一行；拿不准时不写、不放', async () => {
        const ok = await judgeOnQQ(said('今天被骂了一天，你能不能好好跟我说两句'), scripted('care', 0.1, ['好好跟我说两句']));
        assert.equal(ok.judgment?.category, 'care');
        assert.deepEqual(ok.pieces?.map(piece => piece.slot), ['judgment']);
        assert.match(ok.logs[0]!, /^语义判断：care/);
        const unsure = await judgeOnQQ(said('嗯嗯'), scripted('unclear', 0.8));
        assert.equal(unsure.judgment, undefined);
        assert.deepEqual(unsure.pieces, []);
        assert.match(unsure.logs[0]!, /退回关键词/);
    });

    test('别的档位、危机、主动找他、只想一想、快照、最后一句不是他：不问', async () => {
        const cases: Array<[Partial<Turn>, TurnFacts, ChatMessage[]]> = [
            [{ contact: { qq: 2, name: '同学', tier: 'classmate' } }, {}, said('哄我一下')],
            [{}, { crisis: { match: '撑不下去', level: 'high' } }, said('哄我一下')],
            [{ initiate: {} as never }, {}, said('哄我一下')],
            [{ thinking: true }, {}, said('哄我一下')],
            [{ snapshot: true }, {}, said('哄我一下')],
            [{}, {}, [user('哄我一下'), her('好呀')]],
        ];
        for (const [extra, facts, history] of cases) {
            const ask = scripted('care', 0.1, ['哄我']);
            const run = await judgeOnQQ(history, ask, extra, facts);
            assert.equal(ask.calls.length, 0);
            assert.equal(run.judgment, undefined);
            assert.deepEqual(run.logs, []);
        }
    });

    test('开关只认 1；关着时 buildTurnModules 不挂这个模块（一个字不变）', () => {
        const deps = {
            log: () => {}, now: () => 0, history: () => [], contacts: () => [], worldState: () => undefined, appointmentsAt: () => [], promises: () => undefined,
            schedule: false, herDays: false, grievance: false, lagTail: false, lifeInPrompt: false, intent: {},
            semanticAsk: async () => '',
        } as unknown as TurnModuleDeps;
        const original = process.env.QQBOT_SEMANTIC_JUDGMENT;
        try {
            process.env.QQBOT_SEMANTIC_JUDGMENT = 'true';
            assert.equal(semanticJudgmentOn(), false, '只认 1');
            delete process.env.QQBOT_SEMANTIC_JUDGMENT;
            assert.equal(semanticJudgmentOn(), false);
            assert.ok(!buildTurnModules(deps).some(module => module.id === 'semantic-judgment'));
            process.env.QQBOT_SEMANTIC_JUDGMENT = '1';
            const modules = buildTurnModules(deps);
            assert.equal(modules.at(-1)?.id, 'semantic-judgment', '挂在最后：assess 时危机已经判过');
            const { semanticAsk: _ask, ...withoutAsk } = deps;
            assert.ok(!buildTurnModules(withoutAsk as TurnModuleDeps).some(module => module.id === 'semantic-judgment'), '没给调用也不挂');
        } finally {
            if (original === undefined) delete process.env.QQBOT_SEMANTIC_JUDGMENT; else process.env.QQBOT_SEMANTIC_JUDGMENT = original;
        }
    });
});

// ── 验收：同意图不同措辞、同词不同意图、引用和转述、否定、明确转话题、证据不足 ──
// 每一条：合成对话、假模型按剧本给的判断、他实际的意思（人标的）、一稿固定的草稿；对照「只看关键词」和「有判断」时出口检查认成什么、最后是照发还是重写。

interface Case {
    name: string;
    kind: string;
    history: ChatMessage[];
    /** 他实际的意思（人标的） */
    truth: JudgmentCategory;
    /** 假模型这一回给的；undefined = 给一段读不懂的 */
    model?: { category: JudgmentCategory; uncertainty: number; quotes: string[] };
    draft: string;
}

const JOKE = [user('刚才那个笑话我还在笑。'), her('小心梦里都接着笑。')];
const CASES: Case[] = [
    { kind: '同意图不同措辞', name: '原话求哄', history: [user('我认真想听你哄我一下。')], truth: 'care', model: { category: 'care', uncertainty: 0.05, quotes: ['想听你哄我'] }, draft: '行吧，笨。' },
    { kind: '同意图不同措辞', name: '换个说法求关心', history: [user('今天被骂了一天，你能不能好好跟我说两句')], truth: 'care', model: { category: 'care', uncertainty: 0.15, quotes: ['好好跟我说两句'] }, draft: '行吧，笨。' },
    { kind: '同意图不同措辞', name: '撑不住了想被哄', history: [user('哄我一下，真的有点撑不住了')], truth: 'care', model: { category: 'care', uncertainty: 0.1, quotes: ['有点撑不住了'] }, draft: '行吧，笨。' },
    { kind: '同词不同意图', name: '撒娇式哄我', history: [her('还不睡？'), user('哄我一下嘛，不哄我就不睡了~')], truth: 'banter', model: { category: 'banter', uncertainty: 0.2, quotes: ['不哄我就不睡了'] }, draft: '行吧，笨。' },
    { kind: '同词不同意图', name: '说回来是转正事', history: [...JOKE, user('嗯。说回来，照片明早再发。')], truth: 'closing', model: { category: 'closing', uncertainty: 0.1, quotes: ['照片明早再发'] }, draft: '笑到半夜别赖我。' },
    { kind: '同词不同意图', name: '说回来是接着笑', history: [...JOKE, user('说回来，你刚才那个笑话真的绝了哈哈')], truth: 'banter', model: { category: 'banter', uncertainty: 0.1, quotes: ['笑话真的绝了'] }, draft: '你笑点也太低了吧。' },
    { kind: '引用和转述', name: '转述室友的话（分两条发）', history: [user('我室友刚跟他女朋友说了一句：'), user('我认真想听你哄我一下。')], truth: 'none', model: { category: 'none', uncertainty: 0.1, quotes: ['我室友刚跟他女朋友说了一句'] }, draft: '行吧，笨。' },
    { kind: '引用和转述', name: '一句里转述', history: [user('我室友说“我认真想听你哄我一下”，笑死')], truth: 'none', model: { category: 'none', uncertainty: 0.1, quotes: ['我室友说'] }, draft: '行吧，笨。' },
    { kind: '否定', name: '不用哄我', history: [user('不用哄我，我就是说说')], truth: 'none', model: { category: 'none', uncertainty: 0.15, quotes: ['不用哄我'] }, draft: '行吧，笨。' },
    { kind: '否定', name: '不换话题', history: [...JOKE, user('换个话题？不要，我还想听你接着讲笑话')], truth: 'banter', model: { category: 'banter', uncertainty: 0.15, quotes: ['还想听你接着讲笑话'] }, draft: '你笑点也太低了吧。' },
    { kind: '明确转话题', name: '换个话题', history: [...JOKE, user('嗯。换个话题，明天几点出发？')], truth: 'closing', model: { category: 'closing', uncertainty: 0.05, quotes: ['明天几点出发'] }, draft: '你笑点也太低了吧。' },
    { kind: '明确转话题', name: '对了，转正事', history: [...JOKE, user('对了，明天几点出发？')], truth: 'closing', model: { category: 'closing', uncertainty: 0.1, quotes: ['明天几点出发'] }, draft: '你笑点也太低了吧。' },
    { kind: '证据不足', name: '只引了旧话（解析不认）', history: [user('今天好累'), her('辛苦啦'), user('我认真想听你哄我一下。')], truth: 'care', model: { category: 'care', uncertainty: 0.1, quotes: ['今天好累'] }, draft: '行吧，笨。' },
    { kind: '证据不足', name: '模型拿不准', history: [...JOKE, user('嗯')], truth: 'closing', model: { category: 'unclear', uncertainty: 0.7, quotes: [] }, draft: '你笑点也太低了吧。' },
    { kind: '证据不足', name: '模型答非所问', history: [her('我下午捡到一只小猫。'), user('说回来，那只猫后来呢')], truth: 'none', draft: '你笑点也太低了吧。' },
];

describe('验收：同一套合成说法，关键词 vs 语义判断', () => {
    let original: string | undefined;
    beforeEach(() => { original = process.env.QQBOT_PLAYFUL_PERSONA; process.env.QQBOT_PLAYFUL_PERSONA = '1'; });
    afterEach(() => { if (original === undefined) delete process.env.QQBOT_PLAYFUL_PERSONA; else process.env.QQBOT_PLAYFUL_PERSONA = original; });

    const keywordCategory = (history: ChatMessage[]): JudgmentCategory | undefined => {
        const latest = history.at(-1)!.content;
        return keywordCareRequest(latest) ? 'care' : keywordTopicShift(latest) ? 'closing' : undefined;
    };

    test('逐条：有能用的判断就按判断认，没有就按关键词；重写的内容不变', async t => {
        const rows: string[] = [];
        let keywordFalse = 0; let keywordMiss = 0; let judgedFalse = 0; let judgedMiss = 0; let fellBack = 0;
        for (const c of CASES) {
            const ask = c.model ? scripted(c.model.category, c.model.uncertainty, c.model.quotes) : Object.assign(async () => '他大概想聊别的', { calls: [] });
            const run = await judgeOnQQ(c.history, ask);
            const keyword = keywordCategory(c.history);
            const used = run.judgment ? run.judgment.category : keyword;
            if (!run.judgment) fellBack++;
            // 出口检查只认两种（求哄 → care、转话题 → closing）：误拦 = 认成了其中一种但他不是；漏 = 他是其中一种但没认出来
            const tracked = (category: JudgmentCategory | undefined) => (category === 'care' || category === 'closing' ? category : undefined);
            const truth = tracked(c.truth);
            if (tracked(keyword) && tracked(keyword) !== truth) keywordFalse++;
            if (truth && tracked(keyword) !== truth) keywordMiss++;
            if (tracked(used) && tracked(used) !== truth) judgedFalse++;
            if (truth && tracked(used) !== truth) judgedMiss++;
            const keywordPath = await finalPath(turnOf(c.history), c.draft);
            const judgedPath = await finalPath(run.turn, c.draft);
            rows.push(`| ${c.kind} | ${c.name} | ${c.truth} | ${keyword ?? '-'} | ${run.judgment ? run.judgment.category : `退回关键词（${keyword ?? '-'}）`} | 「${c.draft}」 | ${keywordPath} | ${judgedPath} |`);
            // 关键词那条路和原来一模一样：没有判断时两条路同一个结果
            if (!run.judgment) assert.equal(judgedPath, keywordPath, c.name);
        }
        t.diagnostic(['| 类型 | 说法 | 他实际的意思 | 只看关键词 | 语义判断 | 草稿 | 关键词：最后 | 判断：最后 |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'));
        t.diagnostic(`误拦：关键词 ${keywordFalse}，判断 ${judgedFalse}；漏认：关键词 ${keywordMiss}，判断 ${judgedMiss}；退回关键词 ${fellBack} 条`);
        assert.deepEqual({ keywordFalse, keywordMiss, judgedFalse, judgedMiss, fellBack }, { keywordFalse: 4, keywordMiss: 4, judgedFalse: 1, judgedMiss: 1, fellBack: 3 });
    });

    test('明确求哄的原有用例：有判断时照样重写口头禅和照抄，他要睡时照样不拦', async () => {
        const requested = [user('我认真想听你哄我一下。')];
        const run = await judgeOnQQ(requested, scripted('care', 0.05, ['想听你哄我']));
        for (const draft of ['行吧，逗你呢。', '你呀，笨。', '我认真想听你哄我一下。', '你笑点也太低了。']) assert.equal(await finalPath(run.turn, draft), '重写', draft);
        const ending = await judgeOnQQ([...requested, user('嗯，我先睡了。')], scripted('closing', 0.1, ['我先睡了']));
        assert.equal(await finalPath(ending.turn, '行吧，晚安。'), '照发');
        const tired = [user('今天忙了一整天，想放下手机。'), her('明早别赖床啊。'), ...requested];
        const care = await judgeOnQQ(tired, scripted('care', 0.1, ['想听你哄我']));
        assert.equal(await finalPath(care.turn, '那你早点睡，晚安。'), '重写', '累了一整天又认真求哄：别催睡');
    });
});
