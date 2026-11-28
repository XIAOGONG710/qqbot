import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ReviewCtx, Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import { reviewReply, type ReviewOptions } from '../src/language/exit-check.ts';
import { ODD_BODY_WORDS, STILTED_WORDS } from '../src/language/expression.ts';
import type { ChatMessage } from '../src/language/prompt.ts';
import {
    loadStyleRules, resolveStyleRules, skippedSpeechKinds, STYLE_PHRASES_MAX, STYLE_RULE_DEFAULTS, STYLE_RULES, styleBannedWords, styleRulesLogLine,
} from '../src/language/style-rules.ts';
import { correctionReplyLine, isCorrection } from '../src/life/understanding.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { exitOptionsOf, keywordCareRequest, keywordTopicShift, reviewExitModule } from '../src/modules/review-exit.ts';
import { selfMemoryModule } from '../src/modules/self-memory.ts';
import { judgedCorrection, recognizes, semanticJudgmentModule } from '../src/modules/semantic-judgment.ts';
import {
    JUDGMENT_CATEGORIES, JUDGMENT_SYSTEM, judgmentConversation, judgmentLine, judgmentMessages, parseJudgment, reportedSpeech,
    type JudgmentAsk, type JudgmentCategory,
} from '../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';

// 硬编码改造第四批「语言与理解（C）」：软风格规则表、共用判断约定加的两类、第一批补验的两处缺口、当场纠正的提示。只用合成对话、假模型，不调真模型

const user = (content: string): ChatMessage => ({ role: 'user', content });
const her = (content: string): ChatMessage => ({ role: 'assistant', content });
const turnOf = (history: ChatMessage[], facts: TurnFacts = {}): Turn =>
    ({ contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-28T22:00:00+08:00'), history, thinking: false, facts });

/** 按剧本回的假模型：quote 在他最后那几行里找到所在的行 */
function scripted(category: JudgmentCategory, uncertainty: number, quote?: string): JudgmentAsk {
    return async messages => {
        const numbered = messages[1]!.content.split('\n').map(line => /^(\d+) [他她]：(.*)$/u.exec(line)).filter(Boolean) as RegExpExecArray[];
        const hit = quote ? [...numbered].reverse().find(m => m[2]!.includes(quote)) : undefined;
        return JSON.stringify({ category, evidence: quote ? [{ line: hit ? Number(hit[1]) : 99, quote }] : [], uncertainty });
    };
}
async function judged(history: ChatMessage[], ask: JudgmentAsk): Promise<Turn> {
    const module = semanticJudgmentModule({ ask, log: () => {} });
    const turn = turnOf(history);
    module.assess!(turn);
    await module.decideAt!.deliberate!(turn, { history: () => [], log: () => {} });
    return turn;
}

const exit = reviewExitModule().reviewAt!.exit!;
async function finalPath(turn: Turn, draft: string): Promise<'照发' | '重写'> {
    let rewrites = 0;
    const ctx: ReviewCtx = {
        regenerate: async () => { rewrites++; return '（重写稿）'; }, accept: () => {}, dropDevices: () => {}, scratch: {}, log: () => {},
        exit: { speechCheck: false, imageStickers: false }, history: () => [] as StoredMessage[],
    };
    await exit(draft, turn, ctx);
    return rewrites ? '重写' : '照发';
}

describe('软风格规则表（style-rules.ts，QQBOT_STYLE_RULES）', () => {
    test('默认值就是原来写死的：说话毛病全查、医书词和书面腔照旧、那四组说法一字不差', () => {
        assert.equal(STYLE_RULE_DEFAULTS.strictness, 'standard');
        for (const key of ['service', 'ledger', 'blame', 'contrast', 'repeat', 'nag', 'oddBodyWords', 'stiltedWords'] as const) assert.equal(STYLE_RULE_DEFAULTS[key], true, key);
        // 改造前 review-exit.ts 里写死的四组（逐字抄下来）
        assert.deepEqual(STYLE_RULE_DEFAULTS.careAvoid, ['行吧', '笨', '认真想听你哄我', 're:笑点[^。！？]{0,5}低']);
        assert.deepEqual(STYLE_RULE_DEFAULTS.careTiredAvoid, ['re:晚安|早点睡|抓紧睡|赶紧睡|快睡|去睡|睡吧|好好睡|哄(?:你|他)睡|(?:闭眼|躺下)(?:就)?睡']);
        assert.deepEqual(STYLE_RULE_DEFAULTS.closingAvoid, ['re:笑点[^。！？]{0,5}低']);
        assert.deepEqual(STYLE_RULE_DEFAULTS.closingJokeAvoid, ['re:笑话|笑点|笑(?:到|成|够)']);
        assert.deepEqual(Object.keys(STYLE_RULE_DEFAULTS).sort(), ['blame', 'careAvoid', 'careTiredAvoid', 'closingAvoid', 'closingJokeAvoid', 'contrast', 'ledger', 'nag', 'oddBodyWords', 'repeat', 'service', 'stiltedWords', 'strictness'].sort(), '没有多也没有少');
        // 没设变量（测试进程）：用的就是默认；和原来的 [...ODD_BODY_WORDS, ...STILTED_WORDS] 一样，不跳过任何一类
        assert.deepEqual(STYLE_RULES, STYLE_RULE_DEFAULTS);
        assert.deepEqual(styleBannedWords(), [...ODD_BODY_WORDS, ...STILTED_WORDS]);
        assert.equal(skippedSpeechKinds().size, 0);
        assert.equal(styleRulesLogLine(), '', '全默认时不记日志');
    });

    test('严厉程度：relaxed 把软检查全关、说法全清空，可以再按键单独开；硬规则不在表里', () => {
        const relaxed = resolveStyleRules({ strictness: 'relaxed', repeat: true, careAvoid: ['行吧'] });
        assert.equal(relaxed.issue, undefined);
        assert.equal(relaxed.values.service, false);
        assert.equal(relaxed.values.repeat, true);
        assert.deepEqual(relaxed.values.careAvoid, ['行吧']);
        assert.deepEqual(relaxed.values.closingAvoid, []);
        assert.deepEqual(styleBannedWords(relaxed.values), []);
        assert.deepEqual([...skippedSpeechKinds(relaxed.values)].sort(), ['blame', 'contrast', 'ledger', 'nag', 'service']);
        assert.deepEqual(relaxed.changed, ['strictness', 'repeat', 'careAvoid']);
        assert.equal(styleRulesLogLine(relaxed), '软风格规则：relaxed，改了 strictness、repeat、careAvoid');
        const onlyStilted = resolveStyleRules({ oddBodyWords: false });
        assert.deepEqual(styleBannedWords(onlyStilted.values), [...STILTED_WORDS]);
    });

    test('严格解析：有一样不对就整个不用、全部默认，原因只写键名不写内容', () => {
        const bad: unknown[] = [
            null, [], 'relaxed', { strictness: 'loose' }, { unknown: true }, { service: 'no' }, { service: 1 },
            { careAvoid: '行吧' }, { careAvoid: [''] }, { careAvoid: ['   '] }, { careAvoid: [3] }, { careAvoid: ['re:('] }, { careAvoid: ['re:'] },
            { careAvoid: Array.from({ length: STYLE_PHRASES_MAX + 1 }, (_, i) => `词${i}`) }, { careAvoid: ['长'.repeat(201)] },
            { repeat: false, nag: 'x' },
        ];
        for (const value of bad) {
            const result = resolveStyleRules(value);
            assert.ok(result.issue, JSON.stringify(value));
            assert.deepEqual(result.values, STYLE_RULE_DEFAULTS, JSON.stringify(value));
            assert.deepEqual(result.changed, []);
            assert.doesNotMatch(styleRulesLogLine(result), /行吧|词\d|长长/);
        }
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-style-rules-'));
        try {
            const broken = join(dir, 'broken.json');
            writeFileSync(broken, '{"service": fal');
            const unreadable = loadStyleRules(broken);
            assert.equal(unreadable.issue, '文件读不了或不是 JSON');
            assert.equal(styleRulesLogLine(unreadable), '软风格规则：覆盖文件没用上（文件读不了或不是 JSON），全部默认');
            assert.doesNotMatch(styleRulesLogLine(unreadable), /broken|qqbot-style/);
            assert.equal(loadStyleRules(join(dir, 'missing.json')).issue, '文件读不了或不是 JSON');
            assert.deepEqual(loadStyleRules(undefined), { values: STYLE_RULE_DEFAULTS, changed: [] });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('进程启动时读环境变量指的文件：另开一个进程，表跟着文件变；文件不对就整个默认', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-style-rules-'));
        const module = pathToFileURL(join(import.meta.dirname, '..', 'src', 'language', 'style-rules.ts')).href;
        const read = (file: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
            `const m = await import(${JSON.stringify(module)}); console.log(JSON.stringify({ rules: m.STYLE_RULES, words: m.styleBannedWords().length, skip: [...m.skippedSpeechKinds()], line: m.styleRulesLogLine() }))`],
        { env: { ...process.env, QQBOT_STYLE_RULES: file }, encoding: 'utf8' })) as { rules: Record<string, unknown>; words: number; skip: string[]; line: string };
        try {
            const good = join(dir, 'style.json');
            writeFileSync(good, JSON.stringify({ strictness: 'relaxed', nag: true }));
            const relaxed = read(good);
            assert.equal(relaxed.rules.strictness, 'relaxed');
            assert.equal(relaxed.words, 0);
            assert.deepEqual(relaxed.skip.sort(), ['blame', 'contrast', 'ledger', 'repeat', 'service']);
            assert.equal(relaxed.line, '软风格规则：relaxed，改了 strictness、nag');
            writeFileSync(good, JSON.stringify({ strictness: 'relaxed', typo: true }));
            const rejected = read(good);
            assert.deepEqual(rejected.rules, STYLE_RULE_DEFAULTS);
            assert.equal(rejected.words, ODD_BODY_WORDS.length + STILTED_WORDS.length);
            assert.match(rejected.line, /覆盖文件没用上（不认识的键 "typo"）/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('出口检查跟着表走：关掉的软检查不重写；硬规则（做不到的事、卡上禁用词）照样拦', async () => {
        const relaxed = resolveStyleRules({ strictness: 'relaxed' }).values;
        const review = async (reply: string, skip?: ReadonlySet<string>, banned: readonly string[] = ['合成禁词', ...styleBannedWords()]) => {
            let rewrites = 0;
            const options: ReviewOptions = { banned, userName: '阿明', speech: { recent: [], his: ['今天好累'] }, regenerate: async () => { rewrites++; return '好'; }, log: () => {}, ...(skip ? { skip } : {}) };
            await reviewReply(reply, options);
            return rewrites;
        };
        assert.equal(await review('有什么需要随时找我'), 1, '默认：助手腔要重写');
        assert.equal(await review('有什么需要随时找我', skippedSpeechKinds(relaxed)), 0, 'relaxed：助手腔不管');
        assert.equal(await review('听得我嘴角上扬'), 1, '默认：小说神态要重写');
        assert.equal(await review('听得我嘴角上扬', skippedSpeechKinds(relaxed), ['合成禁词', ...styleBannedWords(relaxed)]), 0);
        assert.equal(await review('我给你打电话', skippedSpeechKinds(relaxed), ['合成禁词', ...styleBannedWords(relaxed)]), 1, '做不到的事照拦');
        assert.equal(await review('这是合成禁词', skippedSpeechKinds(relaxed), ['合成禁词', ...styleBannedWords(relaxed)]), 1, '卡上禁用词照拦');
    });

    test('默认时出口检查的上下文和改造前一样：求哄时追加的说法、没有 skip', () => {
        const original = process.env.QQBOT_PLAYFUL_PERSONA;
        process.env.QQBOT_PLAYFUL_PERSONA = '1';
        try {
            const ctx = { regenerate: async () => '', accept: () => {}, dropDevices: () => {}, scratch: {}, log: () => {}, exit: { speechCheck: false, imageStickers: false }, history: () => [] } as ReviewCtx;
            const care = exitOptionsOf(turnOf([user('今天忙了一整天'), her('辛苦'), user('我认真想听你哄我一下。')]), ctx)!;
            assert.deepEqual(care.banned, [...ODD_BODY_WORDS, ...STILTED_WORDS, '行吧', '笨', '认真想听你哄我', 're:笑点[^。！？]{0,5}低',
                're:晚安|早点睡|抓紧睡|赶紧睡|快睡|去睡|睡吧|好好睡|哄(?:你|他)睡|(?:闭眼|躺下)(?:就)?睡']);
            assert.equal('skip' in care, false);
            const closing = exitOptionsOf(turnOf([user('刚才那个笑话我还在笑'), her('小心梦里笑'), user('换个话题，明天几点出发？')]), ctx)!;
            assert.deepEqual(closing.banned.slice(-2), ['re:笑点[^。！？]{0,5}低', 're:笑话|笑点|笑(?:到|成|够)']);
        } finally {
            if (original === undefined) delete process.env.QQBOT_PLAYFUL_PERSONA; else process.env.QQBOT_PLAYFUL_PERSONA = original;
        }
    });
});

describe('共用判断约定：加了「推掉 / 拒绝」「纠正理解」两类，严格解析照旧', () => {
    test('两类都要有依据落在他最后说的那几行；放给她的那一行只说理解', () => {
        assert.deepEqual(JUDGMENT_CATEGORIES, ['care', 'banter', 'closing', 'refusal', 'correction', 'repair', 'brushoff', 'none', 'unclear']);
        const conversation = judgmentConversation([her('周末一起去爬山吧？'), user('不了，这周想在家躺着')]);
        const refusal = parseJudgment(JSON.stringify({ category: 'refusal', evidence: [{ line: 2, quote: '不了' }], uncertainty: 0.1 }), conversation);
        assert.deepEqual(refusal, { category: 'refusal', evidence: [{ line: 2, speaker: 'him', quote: '不了' }], uncertainty: 0.1 });
        assert.match(judgmentLine(refusal), /^\[你对他这几句的理解：他像是在推掉或者不想要你刚才提的事（依据：他说的「不了」；把握：较大）。这只是你的理解/);
        assert.equal(parseJudgment(JSON.stringify({ category: 'refusal', evidence: [{ line: 1, quote: '爬山' }], uncertainty: 0.1 }), conversation), undefined, '只引了她的话不认');
        assert.equal(parseJudgment(JSON.stringify({ category: 'correction', evidence: [], uncertainty: 0.1 }), conversation), undefined, '没有依据不认');
        const fixed = judgmentConversation([user('明天我晚点到'), her('那你别来了'), user('不是，我是说我会晚半小时')]);
        const correction = parseJudgment(JSON.stringify({ category: 'correction', evidence: [{ line: 3, quote: '我是说我会晚半小时' }], uncertainty: 0.3 }), fixed);
        assert.match(judgmentLine(correction), /他像是在纠正你刚才对他的话的理解.*把握：一般/);
        assert.equal(parseJudgment(JSON.stringify({ category: 'correction', evidence: [{ line: 3, quote: '我是说我会晚半小时' }], uncertainty: 0.3, why: 'x' }), fixed), undefined, '多一个字段不认');
    });

    test('提示词写明：玩笑式求哄是接梗（缺口一）、分几条发的转述不是他的要求；两类各有一句定义', () => {
        assert.match(JUDGMENT_SYSTEM, /玩笑式的求哄是 banter，不是 care[^\n]*「不哄我就不睡了」[^\n]*只有他同时说了自己真的累、难受、委屈，或者明说是认真的，才是 care/);
        assert.match(JUDGMENT_SYSTEM, /分成几条发的：前一条说「他说了一句：」，后一条是那句话/);
        assert.match(JUDGMENT_SYSTEM, /- refusal：/);
        assert.match(JUDGMENT_SYSTEM, /- correction：/);
        assert.equal(judgmentMessages(judgmentConversation([user('哄我一下嘛，不哄我就不睡了~')]))[0]!.content, JUDGMENT_SYSTEM, 'QQ 和 DSH 拿的是同一份');
    });

    test('reportedSpeech：同一串里前一条是转述的引子才算；他自己对她说的引子不算', () => {
        const run = (...lines: string[]) => reportedSpeech(judgmentConversation(lines.map(user)));
        assert.equal(run('我室友刚跟他女朋友说了一句：', '我认真想听你哄我一下。'), true);
        assert.equal(run('她回了句', '换个话题'), true);
        assert.equal(run('他发了条“', '我认真想听你哄我一下。”'), true);
        assert.equal(run('我跟你说：', '我认真想听你哄我一下。'), false);
        assert.equal(run('问你个事：', '我认真想听你哄我一下'), false);
        assert.equal(run('我说', '我认真想听你哄我一下'), false);
        assert.equal(run('我也不知道', '我认真想听你哄我一下。'), false);
        assert.equal(run('我认真想听你哄我一下。'), false);
        // 引子在她的话后面才算同一串：中间隔了她的话就不是
        assert.equal(reportedSpeech(judgmentConversation([user('我室友说了一句：'), her('嗯？'), user('我认真想听你哄我一下。')])), false);
    });
});

describe('第一批补验的缺口', () => {
    let original: string | undefined;
    beforeEach(() => { original = process.env.QQBOT_PLAYFUL_PERSONA; process.env.QQBOT_PLAYFUL_PERSONA = '1'; });
    afterEach(() => { if (original === undefined) delete process.env.QQBOT_PLAYFUL_PERSONA; else process.env.QQBOT_PLAYFUL_PERSONA = original; });

    const quoted = [user('我室友刚跟他女朋友说了一句：'), user('我认真想听你哄我一下。')];

    test('缺口二：开着语义判断但退回关键词时，分两条发的转述不当成他的求哄；没开时和原来一样', async () => {
        const fellBack = await judged(quoted, scripted('unclear', 0.7));
        assert.equal(fellBack.facts.semanticJudgment, undefined);
        assert.equal(fellBack.facts.semanticJudgmentFallback, 'uncertain');
        assert.equal(await finalPath(fellBack, '行吧，笨。'), '照发', '退回时不误拦');
        assert.equal(await finalPath(turnOf(quoted), '行吧，笨。'), '重写', '没开语义判断：照旧只看关键词（行为基线不变）');
        // 别的退回原因也一样
        const timedOut = await judged(quoted, async () => { throw new Error('合成故障'); });
        assert.equal(timedOut.facts.semanticJudgmentFallback, 'error');
        assert.equal(await finalPath(timedOut, '行吧，笨。'), '照发');
        // 他自己说的求哄（不是转述）：退回时照旧认
        for (const history of [[user('我认真想听你哄我一下。')], [user('我跟你说：'), user('我认真想听你哄我一下。')]]) {
            const direct = await judged(history, scripted('unclear', 0.7));
            assert.equal(await finalPath(direct, '行吧，笨。'), '重写', history.map(m => m.content).join(' / '));
        }
        // 转话题同理（出口检查、卡末尾那段都经 recognizes）
        const shift = [her('小心梦里都接着笑'), user('她回了句'), user('换个话题')];
        const shiftBack = await judged(shift, scripted('unclear', 0.7));
        assert.equal(recognizes(shiftBack, 'closing', keywordTopicShift), false);
        assert.equal(recognizes(turnOf(shift), 'closing', keywordTopicShift), true, '没开时照旧');
        assert.equal(recognizes(shiftBack, 'care', keywordCareRequest), false);
    });

    test('有能用的判断时仍以判断为准（转述判成 none 照发，判成 care 照样重写）', async () => {
        const none = await judged(quoted, scripted('none', 0.1, '我室友刚跟他女朋友说了一句'));
        assert.equal(none.facts.semanticJudgmentFallback, undefined);
        assert.equal(await finalPath(none, '行吧，笨。'), '照发');
        const care = await judged([user('我认真想听你哄我一下。')], scripted('care', 0.05, '想听你哄我'));
        assert.equal(await finalPath(care, '行吧，笨。'), '重写');
    });

    test('缺口一：「不哄我就不睡了」判成接梗时照发；判成认真求关心才按求哄重写（真模型的准确率要另跑）', async () => {
        const playful = [her('还不睡？'), user('哄我一下嘛，不哄我就不睡了~')];
        assert.equal(await finalPath(await judged(playful, scripted('banter', 0.2, '不哄我就不睡了')), '行吧，笨。'), '照发');
        assert.equal(await finalPath(await judged(playful, scripted('care', 0.2, '不哄我就不睡了')), '行吧，笨。'), '重写');
    });
});

describe('当场纠正的那一轮提示：有判断按判断认「他在纠正」，记下纠正照旧按原话', () => {
    test('correctionReplyLine：judged 给了就按它，没给按关键词', () => {
        assert.equal(isCorrection('不是，我是说我会晚半小时'), false);
        assert.match(correctionReplyLine('不是，我是说我会晚半小时', true) ?? '', /^\[他正在纠正你刚才的理解/);
        assert.equal(correctionReplyLine('我说的是下周', false), undefined, '判断说不是在纠正：这一轮不放');
        assert.match(correctionReplyLine('我说的是下周') ?? '', /^\[他正在纠正你刚才的理解/, '没有判断：照旧按关键词');
        assert.equal(correctionReplyLine('今天好累'), undefined);
    });

    test('self-memory 把判断递给 App：有判断时是 true / false，没有时 undefined', () => {
        const seen: (boolean | undefined)[] = [];
        const module = selfMemoryModule({ understanding: () => undefined, traces: () => undefined, immediateCorrection: (_contact, _words, judged) => { seen.push(judged); return undefined; } });
        const conversation = [user('不是，我是说我会晚半小时')];
        const judgment = parseJudgment(JSON.stringify({ category: 'correction', evidence: [{ line: 1, quote: '我是说' }], uncertainty: 0.1 }), judgmentConversation(conversation))!;
        module.contribute!(turnOf(conversation, { semanticJudgment: judgment }));
        module.contribute!(turnOf(conversation, { semanticJudgment: { ...judgment, category: 'none' } }));
        module.contribute!(turnOf(conversation, { semanticJudgmentFallback: 'timeout' }));
        module.contribute!(turnOf(conversation));
        assert.deepEqual(seen, [true, false, undefined, undefined]);
        assert.equal(judgedCorrection({}), undefined);
    });
});
