import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { RECALLED_TEXT, type StoredMessage } from '../src/memory/history.ts';
import { replySegment } from '../src/platform/onebot.ts';
import type { OpenAIMessage, PromptResult } from '../src/language/prompt.ts';
import { clearQuestion, describeQuote, planQuote, QUOTE_FIX_SHARE, QUOTE_SHARE, quoteFix } from '../src/social/quote-reply.ts';
import { createResponder, type ResponderDeps } from '../src/social/responder.ts';
import { renderReport } from '../src/sim/report.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0136：引用回复。纯函数 + 回复器 + 模拟器里走一遍
const at = (n: number) => new Date(Date.UTC(2026, 9, 24, 12, 0, n)).toISOString();
const him = (content: string, id: number | undefined, n = 0): StoredMessage => ({ time: at(n), role: 'user', content, ...(id !== undefined ? { messageId: id } : {}) });
const her = (content: string, id = 900, n = 0): StoredMessage => ({ time: at(n), role: 'assistant', content, messageId: id });

describe('planQuote：什么时候引用', () => {
    test('只认明确在问的：带问号、句尾吗 / 么、疑问词加呢 / 吗；“我在想去哪玩”这种陈述不算', () => {
        for (const text of ['你周末有空吗？', '你周末有空吗', '晚上吃什么呢', '你几点下课啊', '怎么还不回我?']) assert.equal(clearQuestion(text), true, text);
        for (const text of ['我在想去哪玩', '我不知道吃什么', '今天几乎没怎么睡', '哈哈哈哈', '好的']) assert.equal(clearQuestion(text), false, text);
    });

    test('他连发里有个不是最后一条的问题：引用它（share 给 1 时必引）', () => {
        const plan = planQuote([him('你周末有空吗？', 11), him('我在想去哪玩', 12)], 1, 1);
        assert.deepEqual(plan, { messageId: 11, text: '你周末有空吗？' });
    });

    test('问题只有一条、又是最后一条：不引用（回的就是它）；只有一条消息：不引用', () => {
        assert.equal(planQuote([him('我在想去哪玩', 11), him('你周末有空吗？', 12)], 1, 1), undefined);
        assert.equal(planQuote([him('你周末有空吗？', 11)], 1, 1), undefined);
        assert.equal(planQuote([], 1, 1), undefined);
    });

    test('几个问题：引用最晚的那个不是最后一条的；她回过的不算（只看她上次回复之后的）', () => {
        const history = [him('今天忙吗？', 5), her('还好'), him('晚上吃什么呀？', 11), him('你想吃火锅吗？', 12), him('我有点饿', 13)];
        assert.equal(planQuote(history, 1, 1)?.messageId, 12);
        assert.equal(planQuote([him('今天忙吗？', 5), her('还好'), him('我有点饿', 13), him('哈哈', 14)], 1, 1), undefined, '问题已经在她回过的那边');
    });

    test('不能引用的：合成的 id（戳一戳 / B 站私信）、太短、占位符、他撤回的、已经带引用的', () => {
        const tail = him('我在想去哪玩', 12);
        assert.equal(planQuote([him('你周末有空吗？', 2 ** 32 + 5), tail], 1, 1), undefined, 'id 太大');
        assert.equal(planQuote([him('你周末有空吗？', undefined), tail], 1, 1), undefined, '没有 id');
        assert.equal(planQuote([him('在吗？', 11), tail], 1, 1), undefined, '太短');
        assert.equal(planQuote([him('[图片]你看这个好看吗？', 11), tail], 1, 1), undefined, '占位符开头');
        assert.equal(planQuote([him('[引用你说的：「好」]你周末有空吗？', 11), tail], 1, 1), undefined, '自己就是引用');
        assert.equal(planQuote([him(RECALLED_TEXT, 11), tail], 1, 1), undefined, '撤回的');
        assert.equal(planQuote([him('你周末有空吗？'.repeat(12), 11), tail], 1, 1), undefined, '太长');
    });

    test('share 0 永不引用；默认概率约 QUOTE_SHARE，同一条消息每次算结果一样', () => {
        assert.equal(planQuote([him('你周末有空吗？', 11), him('我在想去哪玩', 12)], 1, 0), undefined);
        let hit = 0;
        for (let id = 100; id < 700; id++) if (planQuote([him('你周末有空吗？', id), him('我在想去哪玩', id + 1)], 1)) hit++;
        assert.ok(hit / 600 > QUOTE_SHARE - 0.1 && hit / 600 < QUOTE_SHARE + 0.1, `${hit / 600}`);
        const history = [him('你周末有空吗？', 4242), him('我在想去哪玩', 4243)];
        assert.deepEqual(planQuote(history, 1), planQuote(history, 1));
    });

    test('quoteFix：补「*对的词」时约 QUOTE_FIX_SHARE 引用那条错的，按消息 id 定', () => {
        let hit = 0;
        for (let id = 1000; id < 1600; id++) if (quoteFix(1, id)) hit++;
        assert.ok(hit / 600 > QUOTE_FIX_SHARE - 0.1 && hit / 600 < QUOTE_FIX_SHARE + 0.1, `${hit / 600}`);
        assert.equal(quoteFix(1, 777), quoteFix(1, 777));
        assert.equal(quoteFix(1, 777, 1), true);
        assert.equal(quoteFix(1, 777, 0), false);
    });

    test('提示词那一行：带上那句话、很长的截断', () => {
        assert.match(describeQuote({ messageId: 1, text: '你周末有空吗？' }), /引用他那句「你周末有空吗？」.*第一条先直接回它/);
        assert.match(describeQuote({ messageId: 1, text: '一二三四五六七八九十'.repeat(5) }), /「一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十…」/);
    });
});

describe('onebot：引用段', () => {
    test('reply 段放最前面，id 是字符串', () => {
        assert.deepEqual(replySegment(123), { type: 'reply', data: { id: '123' } });
    });
});

describe('回复器：第一条带引用', () => {
    function setup(overrides: Partial<ResponderDeps> = {}) {
        const stored: StoredMessage[] = [];
        const sent: { text: string; replyTo?: number }[] = [];
        const deps: ResponderDeps = {
            userId: 1,
            history: { load: () => [...stored], append: (_id, m) => { stored.push(m); } },
            buildPrompt: chat => ({ messages: chat.map(m => ({ role: m.role, content: m.content })), activatedWorldInfo: [] } satisfies PromptResult),
            generate: async () => '有空呀\n你想去哪',
            clean: reply => reply.trim(),
            send: async (_id, text, options) => { sent.push({ text, ...(options?.replyTo !== undefined ? { replyTo: options.replyTo } : {}) }); return 100 + sent.length; },
            log: () => undefined,
            sleep: async () => undefined,
            ...overrides,
        };
        return { responder: createResponder(deps), stored, sent };
    }

    test('quote 给了 id：只有第一条带 replyTo；没给就都是普通的', async () => {
        const quoted = setup({ quote: () => 11 });
        quoted.responder.receive('你周末有空吗？', 11, new Date());
        await quoted.responder.whenIdle();
        assert.deepEqual(quoted.sent, [{ text: '有空呀', replyTo: 11 }, { text: '你想去哪' }]);

        const plain = setup();
        plain.responder.receive('你周末有空吗？', 11, new Date());
        await plain.responder.whenIdle();
        assert.deepEqual(plain.sent, [{ text: '有空呀' }, { text: '你想去哪' }]);
    });

    test('第一条打错字又撤回重发：打错的和重发的都带引用，最后留下的那条是引用的', async () => {
        const quoted = setup({
            quote: () => 11,
            decorate: parts => ({ parts, recall: { index: 0, wrong: '有孔呀', fix: '*空', afterMs: 2500 } }),
            recallOwn: async () => undefined,
        });
        quoted.responder.receive('你周末有空吗？', 11, new Date());
        await quoted.responder.whenIdle();
        assert.deepEqual(quoted.sent, [{ text: '有孔呀', replyTo: 11 }, { text: '有空呀', replyTo: 11 }, { text: '你想去哪' }]);
    });

    test('撤回失败补「*对的词」：quoteFix 说引就引那条错的（id 是发出去的那条），不说就不引', async () => {
        const base = {
            decorate: (parts: string[]) => ({ parts, recall: { index: 0, wrong: '有孔呀', fix: '*空', afterMs: 2500 } }),
            recallOwn: async () => { throw new Error('超过两分钟'); },
        };
        const yes = setup({ ...base, quoteFix: () => true });
        yes.responder.receive('你周末有空吗？', 11, new Date());
        await yes.responder.whenIdle();
        assert.deepEqual(yes.sent, [{ text: '有孔呀' }, { text: '*空', replyTo: 101 }, { text: '你想去哪' }]);

        const no = setup({ ...base, quoteFix: () => false });
        no.responder.receive('你周末有空吗？', 11, new Date());
        await no.responder.whenIdle();
        assert.deepEqual(no.sent, [{ text: '有孔呀' }, { text: '*空' }, { text: '你想去哪' }]);
    });
});

describe('模拟器里走一遍', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const scenarioOf = (quoteReply: boolean, say: string[]) => parseScenario({
        name: '引用回复', tier: 'boyfriend', start: '2026-10-24T20:00:00+08:00', memory: false, ...(quoteReply ? { quoteReply: true, quoteShare: 1 } : {}),
        steps: [{ say }],
    });

    for (const [name, quoteReply] of [['开着', true], ['关着', false]] as const) {
        test(`quoteReply ${name}：他先问了个问题、又接着发了一句`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-quote-sim-'));
            const seen: OpenAIMessage[][] = [];
            try {
                const result = await runScenario(scenarioOf(quoteReply, ['你周末有空吗？', '我在想去哪玩']), {
                    runId: 'quote', dataDir: dir, card, llm, prompt,
                    generate: async messages => { seen.push(messages); return '有空呀'; },
                });
                const bubbles = result.steps.flatMap(step => step.bubbles);
                const prompts = seen.map(messages => messages.map(m => m.content).join('\n'));
                if (quoteReply) {
                    assert.equal(bubbles[0]?.quote, '你周末有空吗？');
                    assert.ok(prompts.at(-1)!.includes('引用他那句「你周末有空吗？」'));
                    assert.match(renderReport(result), /她（引用「你周末有空吗？」）：有空呀/);
                    assert.ok(bubbles.slice(1).every(b => b.quote === undefined), '只有第一条引用');
                } else {
                    assert.ok(bubbles.length > 0 && bubbles.every(b => b.quote === undefined), '关着：不引用');
                    assert.ok(prompts.every(p => !p.includes('引用他那句')), '关着时提示词里没有这一行');
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }
});
