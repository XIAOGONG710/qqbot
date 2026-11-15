import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ReviewCtx, Turn } from '../src/interpreter/interpreter.ts';
import type { ReviewOptions } from '../src/language/exit-check.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { intentModule } from '../src/modules/intent.ts';
import { reviewFinalizeModule } from '../src/modules/review-finalize.ts';
import { reviewUnfinishedModule } from '../src/modules/review-unfinished.ts';
import { createContactResponder } from '../src/platform/contact.ts';
import { parseCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

// 删行收尾（ADR 0336「生成之后那一段」第 2 步；ADR 0321）：只用合成数据、假模型
const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date('2026-11-20T20:00:00+08:00'), history: [], thinking: false, facts: {} };
const finalize = reviewFinalizeModule().reviewAt!.finalize!;

function setup() {
    const ctxLogs: string[] = [];
    const exitLogs: string[] = [];
    let regenerated = 0;
    const ctx: ReviewCtx = { regenerate: async () => { regenerated++; return '重写'; }, accept: () => {}, scratch: {}, log: line => { ctxLogs.push(line); } };
    const exitOptions: ReviewOptions = { banned: ['秘密'], userName: '阿明', regenerate: async () => { regenerated++; return '重写'; }, log: line => { exitLogs.push(line); } };
    return { ctx, exitOptions, ctxLogs, exitLogs, regenerated: () => regenerated };
}

describe('删行收尾模块（ADR 0336）', () => {
    test('只挂在 finalize 这一个位置', () => {
        assert.deepEqual(Object.keys(reviewFinalizeModule().reviewAt!), ['finalize']);
    });

    test('用出口检查那一刻写进 scratch 的同一份上下文：禁用词那一行删掉，日志记在那份上下文的 log 上；不调模型', () => {
        const s = setup();
        s.ctx.scratch.exitOptions = s.exitOptions;
        const out = finalize('秘密\n好呀', turn, s.ctx);
        assert.equal(out, '好呀');
        assert.equal(s.regenerated(), 0);
        assert.deepEqual(s.ctxLogs, []);
    });

    test('照抄聊天记录里的「[B 站私信]」标记：去掉标记留下话', () => {
        const s = setup();
        s.ctx.scratch.exitOptions = s.exitOptions;
        assert.equal(finalize('[B 站私信] 好呀', turn, s.ctx), '好呀');
        assert.ok(s.exitLogs.some(line => line.includes('[B 站私信]')), s.exitLogs.join('|'));
        assert.deepEqual(s.ctxLogs, []);
    });

    test('同步返回（原来这一步不 await，不多一个微任务）', () => {
        const s = setup();
        s.ctx.scratch.exitOptions = s.exitOptions;
        const out = finalize('好呀', turn, s.ctx);
        assert.equal(typeof out, 'string');
        assert.equal(out, '好呀');
    });

    test('删光了也照删（和迁移前一样返回空串，不留原稿）', () => {
        const s = setup();
        s.ctx.scratch.exitOptions = s.exitOptions;
        assert.equal(finalize('秘密', turn, s.ctx), '');
    });

    test('scratch 里没有出口检查的上下文（接线漏了）：原样放过、记一句', () => {
        const s = setup();
        assert.equal(finalize('秘密\n好呀', turn, s.ctx), '秘密\n好呀');
        assert.equal(s.ctxLogs.length, 1);
        assert.match(s.ctxLogs[0]!, /删行收尾/);
    });
});

describe('联系人流水线里的删行收尾（接线前后都应通过）', () => {
    const NOW = Date.parse('2026-11-05T12:00:00+08:00');
    const llm = { baseUrl: 'https://unused.invalid', model: 'fake', apiKey: 'fake', temperature: 0, maxTokens: 300, timeoutMs: 100, extraBody: {}, promptPostProcessing: '' as const };

    test('话说到一半的重写带进来禁用词：最后这一关删掉那一行', async () => {
        const rows: StoredMessage[] = [];
        const sent: string[] = [];
        let calls = 0;
        const responder = createContactResponder({
            contact: { qq: 1, name: '小明', tier: 'boyfriend', knowsBot: true },
            card: { character: parseCharacterCard({ spec: 'chara_card_v2', data: { name: '小红', extensions: { qqbot: { banned: ['秘密'] } } } }), worldInfo: [] }, llm,
            prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
            history: { load: () => [...rows], append: (_qq, message) => { rows.push(message); } },
            now: () => NOW, log: () => {}, settle: { quietMs: 0, maxMs: 0 }, retryAfterMs: [],
            speechCheck: true,
            turnModules: [intentModule(), reviewUnfinishedModule(), reviewFinalizeModule()],
            send: async (_qq, text) => { sent.push(text); return sent.length + 100; },
            generate: async () => (++calls === 1 ? '我知道了\n不过你别得意' : '秘密\n好呀'),
        });
        try { responder.receive('今天心情不错', 1, new Date(NOW)); await responder.whenIdle(); } finally { responder.stop(); }
        assert.equal(calls, 2);
        assert.deepEqual(sent, ['好呀']);
    });
});
