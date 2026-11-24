import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Fetch, LlmOptions } from '../src/language/llm.ts';
import { ModelGuard } from '../src/language/model-guard.ts';
import { SEGMENTS, overlap, renderReport, renderTable, runProbe, similarText, summarize, thinkingOff } from '../src/sim/extraction-probe.ts';

// 抽取 / 事实审稿关思考的 A/B 探针：不连网，假的接口按请求体里的 thinking 认出是哪一臂，核对两臂发出去的参数和汇总。

const LLM: LlmOptions = {
    baseUrl: 'https://example.invalid', model: 'fake-model', apiKey: 'k', temperature: 1.1, maxTokens: 1000, timeoutMs: 60_000,
    extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'high', keep: 1 },
};
const SLIPS = ['麻辣香锅', '跑了五圈', '两节高数课'];

interface Sent { arm: 'live' | 'off'; kind: string; body: Record<string, unknown> }

function fakeFetch(sent: Sent[]): Fetch {
    return async (_url, init) => {
        const body = JSON.parse(init.body) as Record<string, unknown> & { messages: { content: string }[] };
        const thinking = (body.thinking as { type?: string } | undefined)?.type;
        const arm = thinking === 'disabled' ? 'off' : 'live';
        const system = body.messages[0]!.content;
        const user = body.messages[1]?.content ?? '';
        let kind: string;
        let content: string;
        if (system.includes('你是审稿员')) {
            kind = 'facts';
            const reply = user.slice(user.indexOf('## 她准备发出去的回复'));
            const slip = SLIPS.find(s => reply.includes(s));
            // 同线上的一臂抓到预埋的错，关思考的一臂漏掉
            content = arm === 'live' && slip ? JSON.stringify([{ quote: slip, kind: 'contradicts', why: '事实里没有' }]) : '[]';
        } else if (system.includes('答应过的事')) {
            kind = 'promises';
            content = JSON.stringify({ add: [{ what: '给他讲小说结局', date: null }], waiting: [], unanswered: [], unsettled: [], resolved: [], world: [] });
        } else if (system.includes('待跟进的事')) {
            kind = 'followups';
            // 关思考的一臂有一半输出坏掉
            content = arm === 'off' && sent.filter(s => s.kind === 'followups' && s.arm === 'off').length % 2 === 0 ? '想不出来' : JSON.stringify({ add: [{ what: '高数期中考', date: '2026-11-26', time: 'afternoon' }], resolved: [] });
        } else if (system.includes('一个人安静地回想')) {
            kind = 'feelings';
            content = '{}';
        } else throw new Error(`认不出的请求：${system.slice(0, 40)}`);
        sent.push({ arm, kind, body });
        const response = { choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: arm === 'live' ? 40 : 0 } } };
        return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    };
}

describe('抽取关思考 A/B 探针', () => {
    test('关思考：thinking 置 disabled、去掉 reasoning_effort，其余不动', () => {
        const off = thinkingOff(LLM);
        assert.deepEqual(off.extraBody, { thinking: { type: 'disabled' }, keep: 1 });
        assert.equal(off.model, LLM.model);
        assert.deepEqual(LLM.extraBody.thinking, { type: 'enabled' });
    });

    test('文字相近和重合度', () => {
        assert.equal(similarText('给他讲《三体》的结局', '给他讲三体结局'), true);
        assert.equal(similarText('高数期中考试', '去医院复查牙'), false);
        assert.equal(overlap([], []), 1);
        assert.equal(overlap([{ key: 'a', text: '高数考试' }], [{ key: 'b', text: '高数考试' }]), 0);
        assert.equal(overlap([{ key: 'a', text: '高数考试' }, { key: 'a', text: '复查牙齿' }], [{ key: 'a', text: '高数期中考试' }]), 2 / 3);
    });

    test('两臂发出去的参数和线上接线一致，汇总按臂分开算', async () => {
        const sent: Sent[] = [];
        const runs = 2;
        const samples = await runProbe({ llm: LLM, runs, parallel: 3, fetch: fakeFetch(sent), guard: new ModelGuard({ concurrent: 64, backgroundConcurrent: 64 }) });
        const audits = SEGMENTS.filter(s => s.audit).length;
        assert.equal(samples.length, (SEGMENTS.length * 3 + audits) * 2 * runs);
        assert.equal(sent.length, samples.length);

        for (const { arm, kind, body } of sent) {
            if (arm === 'live') {
                assert.deepEqual(body.thinking, { type: 'enabled' });
                assert.equal(body.reasoning_effort, 'high');
            } else {
                assert.deepEqual(body.thinking, { type: 'disabled' });
                assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
            }
            assert.equal(body.keep, 1);
            assert.equal(body.max_tokens, 8192, 'forExtraction 放大输出上限');
            assert.equal(body.temperature, kind === 'facts' ? 0 : kind === 'feelings' ? 0.9 : 1.1);
        }
        assert.equal(sent.filter(s => s.arm === 'live').length, sent.filter(s => s.arm === 'off').length);

        const rows = summarize(samples);
        const row = (extractor: string, arm: string) => rows.find(r => r.extractor === extractor && r.arm === arm)!;
        // 回想：每段都到了回想的条件，回 {} 就是解析成功、零条
        assert.equal(row('feelings', 'live').ok, SEGMENTS.length * runs);
        assert.equal(row('feelings', 'off').meanItems, 0);
        assert.equal(row('promises', 'live').meanItems, 1);
        assert.equal(row('promises', 'live').crossArm, 1);
        assert.equal(row('promises', 'off').withinArm, 1);
        // 待跟进：关思考那一臂一半坏掉
        assert.equal(row('followups', 'live').ok, SEGMENTS.length * runs);
        assert.equal(row('followups', 'off').ok, SEGMENTS.length * runs / 2);
        // 审稿：同线上抓到全部预埋的错，关思考全漏；干净稿都没误报
        const slipped = SEGMENTS.filter(s => s.audit?.slip).length;
        assert.deepEqual(row('facts', 'live').caught, { hit: slipped * runs, of: slipped * runs });
        assert.deepEqual(row('facts', 'off').caught, { hit: 0, of: slipped * runs });
        assert.deepEqual(row('facts', 'live').falseAlarm, { hit: 0, of: (audits - slipped) * runs });
        assert.equal(row('facts', 'live').crossArm, (audits - slipped) / audits);
        // token：接口给的 usage
        assert.equal(row('promises', 'live').meanReasoning, 40);
        assert.equal(row('promises', 'off').meanReasoning, 0);
        assert.equal(row('promises', 'off').meanPrompt, 100);

        const table = renderTable(rows);
        assert.equal(table.split('\n').length, 2 + 4 * 2);
        assert.match(table, /事实审稿 \| 同线上 \| 100%（10\/10）/);
        assert.match(table, /抓到预埋错误 0%（0\/6）/);
        const report = renderReport(LLM, runs, samples);
        assert.match(report, /关思考：thinking=\{"type":"disabled"\}，reasoning_effort="（未设）"/);
        assert.match(report, /s1-约饭/);
    });

    test('--only 只跑选中的', async () => {
        const sent: Sent[] = [];
        const samples = await runProbe({ llm: LLM, runs: 1, only: ['facts'], fetch: fakeFetch(sent), guard: new ModelGuard({ concurrent: 8, backgroundConcurrent: 8 }) });
        assert.ok(samples.every(s => s.extractor === 'facts'));
        assert.equal(samples.length, SEGMENTS.filter(s => s.audit).length * 2);
    });
});
