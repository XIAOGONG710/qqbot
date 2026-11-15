import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewCtx, Turn } from '../src/interpreter/interpreter.ts';
import { findUnfinished, repairUnfinished } from '../src/language/unfinished.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { reviewUnfinishedModule } from '../src/modules/review-unfinished.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 话说到一半（ADR 0336「生成之后那一段」第 4 步；ADR 0141）：只用合成数据、假模型
const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts: {} };
const unfinished = reviewUnfinishedModule().reviewAt!.unfinished!;

function ctxWith(rewrite: (note: string) => Promise<string>) {
    const notes: string[] = [];
    const logs: string[] = [];
    let accepted = 0;
    const ctx: ReviewCtx = {
        regenerate: note => { notes.push(note); return rewrite(note); },
        accept: () => { accepted++; },
        dropDevices: () => {},
        scratch: {},
        log: line => { logs.push(line); },
    };
    return { ctx, notes, logs, accepted: () => accepted };
}

describe('话说到一半模块（ADR 0336）', () => {
    test('只挂在 unfinished 这一个位置', () => {
        assert.deepEqual(Object.keys(reviewUnfinishedModule().reviewAt!), ['unfinished']);
    });

    test('说完了的：原样返回，不重写', async () => {
        const s = ctxWith(async () => '不该调');
        assert.equal(await unfinished('好呀\n周末见', turn, s.ctx), '好呀\n周末见');
        assert.deepEqual(s.notes, []);
        assert.equal(s.accepted(), 0);
    });

    test('停在转折上：带说明重写一次，重写好了就用它，算「采用重写」', async () => {
        const s = ctxWith(async () => '可以呀\n下雨就在宿舍看');
        assert.equal(await unfinished('可以呀\n不过要是下雨的话', turn, s.ctx), '可以呀\n下雨就在宿舍看');
        assert.equal(s.notes.length, 1);
        assert.match(s.notes[0]!, /有一条话没说完/);
        assert.equal(s.accepted(), 1);
        assert.ok(s.logs.some(line => line.startsWith('话没说完：') && line.includes('带说明重写一次')), s.logs.join('|'));
        // 日志只记种类和条数，不记原话
        assert.ok(s.logs.every(line => !line.includes('下雨')), s.logs.join('|'));
    });

    test('重写是空的：不采用，按原稿就地处理（并回前一条）', async () => {
        const s = ctxWith(async () => '');
        const draft = '可以呀\n不过要是下雨的话';
        assert.equal(await unfinished(draft, turn, s.ctx), repairUnfinished(draft, findUnfinished(draft)).reply);
        assert.equal(s.accepted(), 0);
    });

    test('重写抛错：记一句，按原稿就地处理，不往外抛', async () => {
        const s = ctxWith(async () => { throw new Error('模型挂了'); });
        const out = await unfinished('可以呀\n不过要是下雨的话', turn, s.ctx);
        assert.equal(typeof out, 'string');
        assert.equal(s.accepted(), 0);
        assert.ok(s.logs.some(line => line.includes('重写失败（模型挂了）')), s.logs.join('|'));
    });

    test('和直接调 finishReply 用的是同一组函数（重写、采用、日志都是 ctx 上的那几个）', async () => {
        const s = ctxWith(async () => '可以呀\n下雨就在宿舍看');
        await unfinished('可以呀\n不过要是下雨的话', turn, s.ctx);
        assert.equal(s.notes.length, 1);
        assert.equal(s.accepted(), 1);
        assert.ok(s.logs.length >= 1);
    });
});

describe('联系人流水线里的话说到一半（接线前后都应通过）', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    test('开了说话检查：停在转折上的那条重写一次，发出去的是重写稿', async () => {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const logs: string[] = [];
        let calls = 0;
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: line => { logs.push(line); }, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            speechCheck: true,
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewUnfinishedModule()],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async messages => {
                calls++;
                return messages.some(m => typeof m.content === 'string' && m.content.includes('有一条话没说完')) ? '我知道了\n你别得意就行' : '我知道了\n不过你别得意';
            },
        });
        try { responder.receive('今天心情不错', 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        assert.equal(calls, 2);
        assert.ok(sent.length > 0 && sent.every(text => !text.includes('不过')), sent.join('|'));
        // 一轮只重写一次：接线前（旧逻辑 + 模块）也不会因为跑两遍而多重写
        assert.equal(logs.filter(line => line.includes('话没说完：') && line.includes('带说明重写一次')).length, 1, logs.join('|'));
    });
});
