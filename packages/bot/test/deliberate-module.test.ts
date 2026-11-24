import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { DELIBERATE_NOTE } from '../src/language/deliberate.ts';
import { ROUTED_HINTS, WEIGH_SYSTEM } from '../src/language/turn-weight.ts';
import { deliberateModule } from '../src/modules/deliberate.ts';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 深思（ADR 0151）和语义路由（ADR 0202）的段落迁成模块（ADR 0336）：判断留在联系人流水线原位（语义路由那次模型调用不挪过 await），
// 旧逻辑写 turn.facts.deliberate / routedHint，模块只放 deliberate、routedHint 两个槽。
// 行为基线里只有 rich-chat 一轮深思（关键词那条路），没有一个场景开 depthRouting——routedHint 槽和模拟器那一路由这里核对
describe('深思模块（ADR 0151 / 0202 / 0336）', () => {
    const at = new Date('2026-11-20T20:00:00+08:00');
    const turnOf = (facts: TurnFacts = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '你觉得我该不该去北京实习？', time: at.toISOString() }], thinking: false, facts,
    });
    const run = (t: Turn, note?: string) => deliberateModule(note === undefined ? {} : { note }).contribute!(t) as Piece[];

    test('不是深思的轮次：什么都不放', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({ deliberate: false })), []);
    });

    test('深思：deliberate 槽放「先想清楚」那一句；模拟器给了 --deliberate-note 就换成它', () => {
        assert.deepEqual(run(turnOf({ deliberate: true })), [{ slot: 'deliberate', text: DELIBERATE_NOTE }]);
        assert.deepEqual(run(turnOf({ deliberate: true }), '[自己写的那一句]'), [{ slot: 'deliberate', text: '[自己写的那一句]' }]);
    });

    test('语义路由放进深思的：再放 routedHint 槽那一小句（旧逻辑写好的原文）', () => {
        assert.deepEqual(run(turnOf({ deliberate: true, routedHint: ROUTED_HINTS.heavy! })), [
            { slot: 'deliberate', text: DELIBERATE_NOTE },
            { slot: 'routedHint', text: ROUTED_HINTS.heavy! },
        ]);
    });

    test('同步返回：不多等一个微任务（行为基线核对事件顺序）；拼出来深思那一句在方向那一句前面', () => {
        const assembled = contributeTurn([deliberateModule()], turnOf({ deliberate: true, routedHint: ROUTED_HINTS.us! }));
        assert.ok(!(assembled instanceof Promise));
        const text = [...assembled.afterMain, ...assembled.afterHistory].join('\n');
        assert.ok(text.includes(DELIBERATE_NOTE) && text.includes(ROUTED_HINTS.us!));
        assert.ok(text.indexOf(DELIBERATE_NOTE) < text.indexOf(ROUTED_HINTS.us!));
    });
});

// 模拟器那一路（--deliberate、--deliberate-note、--depth）：行为基线碰不到；模拟器没挂模块、或者没把 --deliberate-note 交给模块，这几条报错
describe('模拟器挂着深思的模块（ADR 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const deliberateLlm: BotConfig['llm'] = { ...llm, model: 'x-pro' };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const run = async (said: string, patch: { deliberate?: boolean; note?: string; depth?: string } = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-deliberate-sim-'));
        const prompts: string[] = [];
        let weighed = 0;
        try {
            await runScenario(parseScenario({
                name: 'deliberate', tier: 'boyfriend', start: '2026-11-10T20:00:00+08:00', memory: false, schedule: false,
                steps: [{ say: said }, { advance: '10m' }],
            }), {
                runId: 'deliberate', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                ...(patch.deliberate ? { deliberateLlm } : {}), ...(patch.note ? { deliberateNote: patch.note } : {}), ...(patch.depth ? { depthRouting: true } : {}),
                generate: async messages => {
                    const text = messages.map(m => String(m.content)).join('\n');
                    if (text.includes(WEIGH_SYSTEM)) { weighed++; return patch.depth ?? '{"kind":"light"}'; }
                    prompts.push(text);
                    return '嗯嗯';
                },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        return { prompts, weighed };
    };

    test('--deliberate：认真问她的轮次有「先想清楚」那一句；没开就没有；--deliberate-note 换掉那一句', async () => {
        const asked = '你觉得我该不该去北京实习？';
        assert.ok((await run(asked, { deliberate: true })).prompts[0]!.includes(DELIBERATE_NOTE));
        assert.ok(!(await run(asked)).prompts[0]!.includes(DELIBERATE_NOTE));
        const noted = (await run(asked, { deliberate: true, note: '[模拟器自己写的深思那一句]' })).prompts[0]!;
        assert.ok(noted.includes('[模拟器自己写的深思那一句]'));
        assert.ok(!noted.includes(DELIBERATE_NOTE));
    });

    test('--depth：关键词没认出来、分类说在说沉重的事——深思那一句加方向那一句；分类说闲聊就都没有', async () => {
        const heavy = await run('今天回去看了我爷爷，他有点认不得我了', { deliberate: true, depth: '{"kind":"heavy","why":"亲人"}' });
        assert.equal(heavy.weighed, 1);
        assert.ok(heavy.prompts[0]!.includes(DELIBERATE_NOTE));
        assert.ok(heavy.prompts[0]!.includes(ROUTED_HINTS.heavy!));
        const light = await run('今天回去看了我爷爷，他有点认不得我了', { deliberate: true, depth: '{"kind":"light"}' });
        assert.equal(light.weighed, 1);
        assert.ok(!light.prompts[0]!.includes(DELIBERATE_NOTE));
        assert.ok(!light.prompts[0]!.includes(ROUTED_HINTS.heavy!));
    });
});
