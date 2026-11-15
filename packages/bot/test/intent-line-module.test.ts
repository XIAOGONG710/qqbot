import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { intentLineModule, type IntentLineFacts } from '../src/modules/intent-line.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 这一轮的意图行（ADR 0019 起）和「/亲热」那一行（ADR 0170）迁成模块（ADR 0336）：意图行按 facts.intent / facts.deliberate 现算
// （深思时只管「怎么答」的那两种不放），「/亲热」那一行在联系人流水线原位取（每取一次扣一条、写文件），写进 facts.intimateLine，模块只放。
// 行为基线：意图行 37 个场景、238 处；深思去掉「先直接回答」只有 rich-chat 那一轮；「/亲热」0 处，由这里最后一项管。

type Facts = TurnFacts & IntentLineFacts;

const DIRECT = '[这一轮你想：他问了你一个问题，先直接回答他刚问的，再说别的]';
const ABSTRACT = '[这一轮你想：他在问一个很大、很抽象的问题，挑一个你真有感觉的角度说]';
const PRESS = '[这一轮你想：他在追着要一个答案，别再绕]';
const INTIMATE = '[他刚让你亲热一点：接下来这几条，说话软一点，主动要抱抱、亲一下、说想他都可以；只限这几条，别腻到不像你，也别每条都撒娇]';

describe('意图行和「/亲热」（ADR 0019 / 0151 / 0170 / 0336）', () => {
    const at = new Date('2026-11-05T12:00:00+08:00');
    const turnOf = (facts: Facts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '在吗', time: at.toISOString() }], thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => intentLineModule().contribute!(t) as Piece[];

    test('没有意图、没有「/亲热」：什么都不放；空串当没有', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({ intent: '', intimateLine: '' })), []);
        assert.deepEqual(run(turnOf({ baseIntent: PRESS })), [], '放的是最终的意图（facts.intent），不是改写之前的 baseIntent');
    });

    test('意图行照放；深思的轮次只去掉「怎么答」的那两种，纠偏的照放', () => {
        for (const intent of [DIRECT, ABSTRACT, PRESS]) assert.deepEqual(run(turnOf({ intent })), [{ slot: 'intent', text: intent }], intent);
        assert.deepEqual(run(turnOf({ intent: DIRECT, deliberate: true })), []);
        assert.deepEqual(run(turnOf({ intent: ABSTRACT, deliberate: true })), []);
        assert.deepEqual(run(turnOf({ intent: PRESS, deliberate: true })), [{ slot: 'intent', text: PRESS }]);
        assert.deepEqual(run(turnOf({ intent: DIRECT, deliberate: false })), [{ slot: 'intent', text: DIRECT }]);
    });

    test('「/亲热」那一行照放，和意图互不影响（深思也照放）', () => {
        assert.deepEqual(run(turnOf({ intimateLine: INTIMATE })), [{ slot: 'intimate', text: INTIMATE }]);
        assert.deepEqual(run(turnOf({ intent: DIRECT, deliberate: true, intimateLine: INTIMATE })), [{ slot: 'intimate', text: INTIMATE }]);
    });

    test('同步返回；「此刻」块里意图在前、「/亲热」在后', () => {
        const assembled = contributeTurn([intentLineModule()], turnOf({ intimateLine: INTIMATE, intent: PRESS }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterHistory, [[PRESS, INTIMATE].join('\n')]);
    });

    test('联系人流水线那一路：「/亲热」只取一次、提示词里放一次（接线前旧逻辑放、接线后模块放；模块没挂或旧逻辑没写 facts 时是 0）', async () => {
        const NOW = Date.parse('2026-11-05T12:00:00+08:00');
        const rows: StoredMessage[] = [];
        const prompts: OpenAIMessage[][] = [];
        let taken = 0;
        const responder = createContactResponder({
            contact: { qq: 1, name: '阿明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] },
            llm: { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' },
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [intentModule(), intentLineModule()],
            intimacyLine: () => { taken++; return INTIMATE; },
            send: async () => 101,
            generate: async () => '抱抱',
            onPrompt: prompt => { prompts.push(prompt.messages); },
        });
        try { responder.receive('想你了', 1, new Date(NOW)); await responder.whenIdle(); }
        finally { responder.stop(); }
        assert.equal(prompts.length, 1);
        const text = prompts[0]!.map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
        assert.equal(text.split(INTIMATE).length - 1, 1);
        assert.equal(taken, 1);
    });
});
