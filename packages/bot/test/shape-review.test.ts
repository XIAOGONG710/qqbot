import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewCtx, Turn, TurnFacts } from '../src/interpreter/interpreter.ts';
import { shapeReply, type ShapePlan } from '../src/language/shape.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { reviewFinalizeModule } from '../src/modules/review-finalize.ts';
import { shapeModule } from '../src/modules/shape.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 形状裁剪（ADR 0336「生成之后那一段」第 3 步；ADR 0091）：只用合成数据、假模型
const PLAN: ShapePlan = { kind: 'short', cap: 12, maxBubbles: 2 };
const turnWith = (facts: TurnFacts = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts });
const LONG = '今天我在图书馆坐了一下午，看完了半本书，回来的路上还买了奶茶';

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

// 形状裁剪并进了形状模块（modules/shape.ts 的 reviewAt.shape）
const reviewShape = shapeModule({ shape: true, log: () => {} }).reviewAt!.shape! as (text: string, turn: Turn, ctx: ReviewCtx) => string | Promise<string>;

describe('形状裁剪（形状模块的 reviewAt，ADR 0336）', () => {
    test('只挂在 shape 这一个位置', () => {
        assert.deepEqual(Object.keys(shapeModule({ shape: true, log: () => {} }).reviewAt!), ['shape']);
    });

    test('这一轮没有形状：同步原样返回，不重写（原来这种情况不 await）', () => {
        const s = ctxWith(async () => '不该调');
        const out = reviewShape(`${LONG}\n还有\n很多\n条`, turnWith(), s.ctx);
        assert.equal(out, `${LONG}\n还有\n很多\n条`);
        assert.deepEqual(s.notes, []);
        assert.equal(s.accepted(), 0);
    });

    test('有形状、没超：仍返回 promise（原来有形状时总是 await shapeReply），原样', async () => {
        const s = ctxWith(async () => '不该调');
        const out = reviewShape('好呀\n周末见', turnWith({ shape: PLAN }), s.ctx);
        assert.ok(out instanceof Promise);
        assert.equal(await out, '好呀\n周末见');
        assert.deepEqual(s.notes, []);
    });

    test('太长了：带「太长了」的说明重写一次，重写短了就用它，算「采用重写」', async () => {
        const s = ctxWith(async () => '在图书馆待了一下午\n买了奶茶');
        assert.equal(await reviewShape(LONG, turnWith({ shape: PLAN }), s.ctx), '在图书馆待了一下午\n买了奶茶');
        assert.equal(s.notes.length, 1);
        assert.match(s.notes[0]!, /太长了——这一轮每条不超过 12 个字，最多 2 条/);
        assert.equal(s.accepted(), 1);
        assert.ok(s.logs.some(line => line.startsWith('形状：') && line.includes('带说明重写一次')), s.logs.join('|'));
    });

    test('重写还长：在分句处截断；条数多了去掉后面的', async () => {
        const s = ctxWith(async () => `${LONG}\n第二条\n第三条`);
        const out = await reviewShape(LONG, turnWith({ shape: PLAN }), s.ctx);
        assert.equal(out.split('\n').length, 2);
        assert.ok(out.split('\n')[0]!.length < LONG.length, out);
        assert.ok(s.logs.some(line => line.includes('截到')), s.logs.join('|'));
        assert.ok(s.logs.some(line => line.includes('去掉第 3 条起')), s.logs.join('|'));
    });

    test('重写是空的：不采用，截原稿', async () => {
        const s = ctxWith(async () => '');
        const out = await reviewShape(LONG, turnWith({ shape: PLAN }), s.ctx);
        assert.equal(s.accepted(), 0);
        assert.ok(out.length < LONG.length && LONG.startsWith(out), out);
    });

    test('重写抛错：记一句，直接截断，不往外抛', async () => {
        const s = ctxWith(async () => { throw new Error('模型挂了'); });
        const out = await reviewShape(LONG, turnWith({ shape: PLAN }), s.ctx);
        assert.ok(LONG.startsWith(out) && out.length < LONG.length, out);
        assert.equal(s.accepted(), 0);
        assert.ok(s.logs.some(line => line.includes('形状：重写失败（模型挂了），直接截断')), s.logs.join('|'));
    });

    test('和直接调 shapeReply 逐字一样（同一组重写 / 采用 / 日志）', async () => {
        for (const rewrite of ['短的', `${LONG}\n再一条\n又一条`, '']) {
            const a = ctxWith(async () => rewrite);
            const b = ctxWith(async () => rewrite);
            const viaModule = await reviewShape(LONG, turnWith({ shape: PLAN }), a.ctx);
            const direct = await shapeReply(LONG, PLAN, { regenerate: b.ctx.regenerate, onRewriteAccepted: b.ctx.accept, log: b.ctx.log });
            assert.equal(viaModule, direct);
            assert.deepEqual(a.notes, b.notes);
            assert.deepEqual(a.logs, b.logs);
            assert.equal(a.accepted(), b.accepted());
        }
    });
});

describe('联系人流水线里的形状裁剪（接线前后都应通过）', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    async function run(generate: (call: number) => string) {
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
            // 形状和裁剪是同一个模块
            turnModules: [intentModule(), shapeModule({ shape: true, shapeAll: true, log: () => {} }), reviewFinalizeModule()],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async () => { calls++; return generate(calls); },
        });
        try { responder.receive('今天心情不错', 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        return { sent, logs, calls };
    }

    test('第一版太长：重写一次；一轮只重写一次（接线前旧逻辑 + 模块也不会多重写）', async () => {
        const r = await run(call => (call === 1 ? '今天我有好多好多好多事情想跟你说'.repeat(6) : '好呀'));
        assert.equal(r.calls, 2, r.logs.join('|'));
        assert.equal(r.logs.filter(line => line.includes('形状：') && line.includes('带说明重写一次')).length, 1, r.logs.join('|'));
        assert.ok(r.sent.length > 0);
        assert.deepEqual(r.sent, ['好呀']);
    });
});
