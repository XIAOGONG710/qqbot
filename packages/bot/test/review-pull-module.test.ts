import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewCtx, Turn } from '../src/interpreter/interpreter.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { crisisModule } from '../src/modules/crisis.ts';
import { intentModule } from '../src/modules/intent.ts';
import { pullNote, reviewPullModule } from '../src/modules/review-pull.ts';
import type { Contact } from '../src/platform/config.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 她想查才查（<<查：…>>，ADR 0336「生成之后那一段」第 5 步）：只用合成数据、假记忆、假模型
const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts: {} };

function ctxWith(rewrite = async (_note: string) => '记得呀，学校后门那家火锅店') {
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

function recaller(answer: string | undefined | Error) {
    const calls: { contact: Contact; query: string }[] = [];
    const recall = async (contact: Contact, query: string) => {
        calls.push({ contact, query });
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { recall, calls };
}

const pullOf = (options?: Parameters<typeof reviewPullModule>[0]) => reviewPullModule(options).reviewAt!.pull!;

describe('<<查>> 模块（ADR 0336）', () => {
    test('只挂在 pull 这一个位置', () => {
        assert.deepEqual(Object.keys(reviewPullModule().reviewAt!), ['pull']);
    });

    test('没写标记：同步原样返回，不查', () => {
        const r = recaller('- 火锅店');
        const s = ctxWith();
        const out = pullOf({ recall: r.recall })('记得呀', turn, s.ctx);
        assert.equal(out, '记得呀');
        assert.equal(r.calls.length, 0);
    });

    test('没给查记忆的函数（没开长期记忆 / 模拟器）：同步摘掉标记', () => {
        const s = ctxWith();
        assert.equal(pullOf()('<<查：第一次约会的地方>>\n我想想', turn, s.ctx), '我想想');
        assert.deepEqual(s.notes, []);
        assert.deepEqual(s.logs, []);
    });

    test('关键词是空的：同步摘掉标记，不查', () => {
        const r = recaller('- 火锅店');
        const s = ctxWith();
        assert.equal(pullOf({ recall: r.recall })('我想想<<查： >>', turn, s.ctx), '我想想');
        assert.equal(r.calls.length, 0);
    });

    test('查到了：记一句、带着结果重写一次（不算「采用重写」），重写稿里的标记也摘掉', async () => {
        const r = recaller('[你刚才想起来的]\n- 12月6日：第一次约会去的是学校后门那家火锅店');
        const s = ctxWith(async () => '记得呀\n<<查：又想查>>学校后门那家火锅店');
        const out = await pullOf({ recall: r.recall })('<<查：  第一次约会的地方 >>\n我想想', turn, s.ctx);
        assert.equal(out, '记得呀\n学校后门那家火锅店');
        assert.deepEqual(r.calls.map(c => ({ qq: c.contact.qq, query: c.query })), [{ qq: 1, query: '第一次约会的地方' }]);
        assert.equal(r.calls[0]!.contact, turn.contact);
        assert.deepEqual(s.notes, [pullNote('[你刚才想起来的]\n- 12月6日：第一次约会去的是学校后门那家火锅店')]);
        assert.equal(s.notes[0], '（你刚才想起来了：\n[你刚才想起来的]\n- 12月6日：第一次约会去的是学校后门那家火锅店\n用这些回答他，不要再写 <<查>> 标记。这些记录没有可精确回连的引用；拿不准就直接说不确定，不要写待核对标记，也不要自行改动或删除旧记忆。）');
        assert.deepEqual(s.logs, ['她主动查记忆：第一次约会的地方（1 条）']);
        assert.equal(s.accepted(), 0);
    });

    test('只有有稳定引用的记录才教她写可回连的待核对标记', async () => {
        const reference = 'c'.repeat(24);
        const r = recaller(`- 12月6日（和阿明的私聊）：第一次约会地点 <<记忆引用:${reference}>>`);
        const s = ctxWith();
        await pullOf({ recall: r.recall })('<<查：第一次约会>>\n我想想', turn, s.ctx);
        assert.match(s.notes[0]!, new RegExp(`<<记忆待核对：引用｜疑点>>`));
        assert.match(s.notes[0]!, /引用必须照抄该条末尾的内部引用/);
        assert.doesNotMatch(s.notes[0]!, /记忆核对结果/);
        const withPending = pullNote(`- 第一次约会地点 <<记忆引用:${reference}>>\n[她以前给这条记录留过待核对备注：地点可能记错]`);
        assert.match(withPending, /记忆核对结果：引用｜确认原记录/);
        assert.match(withPending, /记忆核对结果：引用｜补充更正/);
    });

    test('只有本轮带回疑点的重写稿能提交对应核对结果', async () => {
        const reference = 'c'.repeat(24);
        const other = 'd'.repeat(24);
        const offers = [{ reference, at: '2026-11-18T12:00:00Z', note: '地点待核对' }];
        const calls: unknown[] = [];
        const pull = pullOf({
            recall: async () => ({ text: `- 旧记录 <<记忆引用:${reference}>>\n[待核对备注]`, offers }),
            finishReview: (_contact, shown, resolution) => calls.push({ shown, resolution }),
        });
        const marker = (ref: string) => `<<记忆核对结果：${ref}｜确认原记录>>`;
        await pull(marker(reference), turn, ctxWith().ctx);
        assert.deepEqual(calls, []);
        await assert.rejects(async () => pull('<<查：地点>>', turn, ctxWith(async () => { throw new Error('重写失败'); }).ctx), /重写失败/);
        assert.deepEqual(calls, []);
        await pull('<<查：地点>>', turn, ctxWith(async () => marker(other)).ctx);
        await pull('<<查：地点>>', turn, ctxWith(async () => marker(reference)).ctx);
        assert.deepEqual(calls, [
            { shown: offers, resolution: undefined },
            { shown: offers, resolution: { reference, decision: { kind: 'confirm' } } },
        ]);
    });

    test('查不到：不重写，只摘标记', async () => {
        const r = recaller(undefined);
        const s = ctxWith();
        assert.equal(await pullOf({ recall: r.recall })('<<查：借书>>\n我找找哈', turn, s.ctx), '我找找哈');
        assert.equal(r.calls.length, 1);
        assert.deepEqual(s.notes, []);
        assert.deepEqual(s.logs, []);
    });

    test('查记忆出错：当查不到，不往外抛', async () => {
        const r = recaller(new Error('Hindsight 超时'));
        const s = ctxWith();
        assert.equal(await pullOf({ recall: r.recall })('<<查：借书>>\n我找找哈', turn, s.ctx), '我找找哈');
        assert.deepEqual(s.notes, []);
    });

    test('写了几个标记：只按第一个查，全部摘掉；半角冒号也认', async () => {
        const r = recaller(undefined);
        const s = ctxWith();
        assert.equal(await pullOf({ recall: r.recall })('<<查:借书>>我找找<<查：那本书>>哈', turn, s.ctx), '我找找哈');
        assert.deepEqual(r.calls.map(c => c.query), ['借书']);
    });

    test('重写抛错：往外抛（和迁移前一样，这一轮按出错处理）', async () => {
        const r = recaller('- 火锅店');
        const s = ctxWith(async () => { throw new Error('模型挂了'); });
        await assert.rejects(async () => { await pullOf({ recall: r.recall })('<<查：火锅>>\n我想想', turn, s.ctx); }, /模型挂了/);
    });
});

describe('联系人流水线里的 <<查>>', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    test('查到了：发出去的是带着结果重写的那一版', async () => {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        const r = recaller('- 第一次约会去的是学校后门那家火锅店');
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红' } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            turnModules: [crisisModule({ log: () => {} }), intentModule(), reviewPullModule({ recall: r.recall })],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async messages => (messages.some(m => typeof m.content === 'string' && m.content.includes('（你刚才想起来了：')) ? '记得呀，火锅店' : '<<查：第一次约会>>\n我想想'),
        });
        try { responder.receive('还记得我们第一次出去玩去的哪吗', 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        assert.deepEqual(r.calls.map(c => c.query), ['第一次约会']);
        assert.deepEqual(sent, ['记得呀，火锅店']);
    });
});
