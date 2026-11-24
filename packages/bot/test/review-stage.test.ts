import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createInterpreter, REVIEW_STAGES, reviewStage, type Module, type ReviewCtx, type Turn } from '../src/interpreter/interpreter.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 生成之后的审稿位置（ADR 0336「生成之后那一段」第 1 步）：接线不改行为（行为基线 review 等场景逐字不变），这里核对位置本身
describe('审稿顺序表上的位置（ADR 0336）', () => {
    const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts: {} };
    const ctx: ReviewCtx = { regenerate: async () => '重写', accept: () => {}, dropDevices: () => {}, scratch: {}, log: () => {} };

    test('顺序照迁移前的手写顺序', () => {
        assert.deepEqual([...REVIEW_STAGES], ['facts', 'exit', 'pull', 'unfinished', 'finalize', 'factsFinal']);
    });

    test('这个位置没有模块挂：同步返回原稿（不多一个微任务）', () => {
        const other: Module = { id: 'other', reviewAt: { pull: text => `${text}!` } };
        assert.deepEqual(reviewStage([other], 'finalize', '原稿', turn, ctx), { text: '原稿' });
        assert.deepEqual(reviewStage([], 'facts', '原稿', turn, ctx), { text: '原稿' });
    });

    test('挂了模块但都同步返回：整个也同步返回（删行收尾这类同步的步骤不多一个微任务）', () => {
        const a: Module = { id: 'a', reviewAt: { finalize: text => `${text}A` } };
        const b: Module = { id: 'b', reviewAt: { finalize: text => ({ text: `${text}B` }) } };
        const out = reviewStage([a, b], 'finalize', '稿', turn, ctx);
        assert.ok(!(out instanceof Promise));
        assert.deepEqual(out, { text: '稿AB' });
        const stop: Module = { id: 'stop', reviewAt: { finalize: () => ({ text: '停', stop: true }) } };
        assert.deepEqual(reviewStage([stop, a], 'finalize', '稿', turn, ctx), { text: '停', stop: true });
    });

    test('前面同步、中间异步：从异步那一步起转成 promise，顺序不变', async () => {
        const a: Module = { id: 'a', reviewAt: { pull: text => `${text}A` } };
        const b: Module = { id: 'b', reviewAt: { pull: async text => `${text}B` } };
        const c: Module = { id: 'c', reviewAt: { pull: text => `${text}C` } };
        const out = reviewStage([a, b, c], 'pull', '稿', turn, ctx);
        assert.ok(out instanceof Promise);
        assert.deepEqual(await out, { text: '稿ABC' });
    });

    test('只挂了 reviewAt 的模块也交给联系人流水线（createInterpreter 不筛掉它）', () => {
        const only: Module = { id: 'only-review', reviewAt: { finalize: text => text } };
        const interpreter = createInterpreter({ modules: [only], exec: { every: () => 0 as never, cancel: () => {} } });
        assert.deepEqual(interpreter.turnModules.map(module => module.id), ['only-review']);
    });

    test('挂在这个位置的模块按注册顺序跑；返回 stop 时后面的不再跑', async () => {
        const order: string[] = [];
        const a: Module = { id: 'a', reviewAt: { exit: text => { order.push('a'); return `${text}A`; } } };
        const b: Module = { id: 'b', reviewAt: { exit: async text => { order.push('b'); return { text: `${text}B`, stop: true } as const; } } };
        const c: Module = { id: 'c', reviewAt: { exit: text => { order.push('c'); return `${text}C`; } } };
        assert.deepEqual(await reviewStage([a, b, c], 'exit', '稿', turn, ctx), { text: '稿AB', stop: true });
        assert.deepEqual(order, ['a', 'b']);
    });
});

describe('联系人流水线在每个位置调审稿模块（ADR 0336）', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };
    const run = async (modules: Module[]) => {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [crisisModule({ log: () => {} }), intentModule(), ...modules],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async () => '好呀',
        });
        try { responder.receive('今天心情不错', 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        return sent;
    };

    test('没有审稿模块：照常发', async () => {
        assert.deepEqual(await run([]), ['好呀']);
    });

    test('挂在删行收尾位置的模块改了稿子：发出去的是改过的', async () => {
        const seen: { stage: string; text: string }[] = [];
        const module: Module = { id: 'tail', reviewAt: { finalize: (text, turn) => { seen.push({ stage: 'finalize', text }); return `${text}，${turn.contact.name}`; } } };
        assert.deepEqual(await run([module]), ['好呀，小明']);
        assert.deepEqual(seen, [{ stage: 'finalize', text: '好呀' }]);
    });

    test('事实检查位置返回 stop：这一轮到此为止，发的是 stop 带的稿子，后面的位置不跑', async () => {
        let later = 0;
        const stopper: Module = { id: 'stop', reviewAt: { facts: () => ({ text: '就这一句', stop: true }), finalize: text => { later++; return text; } } };
        assert.deepEqual(await run([stopper]), ['就这一句']);
        assert.equal(later, 0);
    });
});
