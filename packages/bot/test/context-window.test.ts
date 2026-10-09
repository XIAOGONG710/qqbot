import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import { contextSummarizer, summaryRequest, turnCut, turnStarts } from '../src/context-window.ts';
import { recentChat } from '../src/memory/fading.ts';
import type { ChatMessage, OpenAIMessage } from '../src/prompt.ts';
import { renderReport } from '../src/sim/report.ts';
import { runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const u = (content: string, time?: string): ChatMessage => ({ role: 'user', content, ...(time ? { time } : {}) });
const a = (content: string, time?: string): ChatMessage => ({ role: 'assistant', content, ...(time ? { time } : {}) });

describe('最近几轮 + 要点（ADR 0043 离线实验）', () => {
    test('一轮 = 他的一条或连着几条 + 她接着的回复；开头是她说的也算一轮', () => {
        assert.deepEqual(turnStarts([u('在吗'), u('人呢'), a('在'), a('咋了'), u('没事'), a('哦')]), [0, 4]);
        assert.deepEqual(turnStarts([a('早'), u('早'), a('吃了没')]), [0, 1]);
        assert.deepEqual(turnStarts([]), []);
    });

    test('至少留 turns 轮，切口每 step 轮挪一次', () => {
        // 7 轮，每轮两条
        const chat = Array.from({ length: 7 }, (_, i) => [u(`他${i}`), a(`她${i}`)]).flat();
        assert.equal(turnCut(chat, { turns: 3, step: 2 }), 4 * 2, '多 4 轮：切掉 4 轮');
        assert.equal(turnCut(chat.slice(0, 12), { turns: 3, step: 2 }), 2 * 2, '多 3 轮：切口还在第 2 轮');
        assert.equal(turnCut(chat.slice(0, 8), { turns: 3, step: 2 }), 0, '多 1 轮：不切');
        assert.equal(turnCut(chat, { turns: 10, step: 4 }), 0);
    });

    test('recentChat 的上限默认 80 条（线上不变），实验传 Infinity 不按条数切', () => {
        const now = new Date('2026-10-09T21:00:00+08:00');
        const chat = Array.from({ length: 100 }, (_, i) => u(`${i}`, new Date(now.getTime() - (100 - i) * 60_000).toISOString()));
        assert.equal(recentChat(chat, now).chat.length, 80);
        assert.equal(recentChat(chat, now, Infinity).chat.length, 100);
    });

    test('整理要点的请求带日期和星期、只要事实；同一段只整理一次，失败不放', async () => {
        const older = [u('我下周三下午两点面试', '2026-10-07T13:01:00.000Z'), a('可以啊你', '2026-10-07T13:02:00.000Z')];
        const request = summaryRequest(older, { user: '宝宝', char: '林梦瑶' });
        assert.match(request[0]!.content, /只写事实，不写语气/);
        // 摘要事实审计（ADR 0043，10-09 探针）：凌晨的「明天」、改口只写最后结果、谁的事
        assert.match(request[0]!.content, /凌晨（0 点到 5 点）还没睡时说的「明天」/);
        assert.match(request[0]!.content, /合成一条只写最后的结果/);
        assert.match(request[0]!.content, /每条写清楚是谁的事：宝宝的室友/);
        assert.equal(request[1]!.content, '[10月7日 周三 21:01] 宝宝：我下周三下午两点面试\n[10月7日 周三 21:02] 林梦瑶：可以啊你');
        const logs: string[] = [];
        let calls = 0;
        const summarize = contextSummarizer({
            names: { user: '宝宝', char: '林梦瑶' },
            generate: async () => { calls++; return '好的，要点如下：\n- 宝宝 10月14日（周三）下午两点面试\n- 无'; },
            log: line => logs.push(line),
        });
        const text = await summarize(older);
        assert.equal(text, '[你们前面聊过的事（更早的聊天原文没放进来，这是要点，只作参考；和下面从记忆里想起来的对不上时，以这里为准）：\n- 宝宝 10月14日（周三）下午两点面试]');
        assert.equal(await summarize([...older]), text);
        assert.equal(calls, 1, '同一段不再整理');
        assert.match(logs[0]!, /^上下文要点：较早的 2 条整理成 1 条（请求约 \d+ token）$/);
        const failing = contextSummarizer({ names: { user: '宝宝', char: '林梦瑶' }, generate: async () => { throw new Error('超时'); }, log: line => logs.push(line) });
        assert.equal(await failing(older), undefined);
        assert.match(logs.at(-1)!, /上下文要点整理失败：超时/);
    });

    test('模拟器 contextTurns：原文只放最近几轮，更早的要点放进提示词，报告里看得到；不传照旧最近 80 条', async () => {
        const repoRoot = resolve(import.meta.dirname, '../../..');
        const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
        const llm: BotConfig['llm'] = {
            baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {},
        };
        const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: false };
        const hindsight: SimHindsight = {
            putBank: async () => {}, retain: async () => {}, recall: async () => [],
            getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {},
            activeOperations: async () => [], operationStatus: async () => 'completed', refreshMentalModel: async () => 'op-1', deleteBank: async () => {},
        };
        // 事先 6 轮
        const history = Array.from({ length: 6 }, (_, i) => [
            { time: `2026-10-09T18:${String(i * 2).padStart(2, '0')}:00+08:00`, role: 'user', content: i === 0 ? '我下周三下午两点面试' : `闲聊${i}` },
            { time: `2026-10-09T18:${String(i * 2 + 1).padStart(2, '0')}:00+08:00`, role: 'assistant', content: `嗯${i}` },
        ]).flat();
        const scenario = parseScenario({
            name: '最近几轮', tier: 'boyfriend', start: '2026-10-09T21:00:00+08:00', schedule: false, history,
            steps: [{ say: '在吗' }, { say: '我面试是哪天来着' }],
        });
        const run = async (contextTurns?: { turns: number; step: number }) => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-ctx-'));
            const prompts: OpenAIMessage[][] = [];
            const summaries: OpenAIMessage[][] = [];
            const generate = async (messages: OpenAIMessage[]) => {
                const system = messages[0]?.role === 'system' ? messages[0].content : '';
                if (system.includes('睡前在写今天') || system.includes('的日记，写一段小结')) return '日记';
                if (system.includes('答应过的事」')) return '{"add":[],"resolved":[]}';
                if (system.startsWith('你在帮')) { summaries.push(messages); return '- 宝宝 10月14日（周三）下午两点面试'; }
                prompts.push(messages);
                return '好';
            };
            try {
                const result = await runScenario(scenario, { runId: 'ctx', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 50, maxMs: 200 }, ...(contextTurns ? { contextTurns } : {}) });
                return { result, prompts, summaries };
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        };
        const chatOf = (messages: OpenAIMessage[]) => messages.filter(m => m.role !== 'system').map(m => m.content);
        const plain = await run();
        assert.ok(chatOf(plain.prompts[0]!).includes('我下周三下午两点面试'), '不传：原文全在（不到 80 条）');
        assert.equal(plain.summaries.length, 0);

        const turns = await run({ turns: 3, step: 2 });
        // 第一轮：事先 6 轮 + 这一轮 = 7 轮，留 3 轮、切口按 2 轮挪 → 切掉 4 轮
        assert.ok(!chatOf(turns.prompts[0]!).includes('我下周三下午两点面试'));
        assert.deepEqual(chatOf(turns.prompts[0]!).filter(c => c.startsWith('闲聊')), ['闲聊4', '闲聊5']);
        const all = turns.prompts[0]!.map(m => m.content).join('\n');
        assert.match(all, /\[你们前面聊过的事（更早的聊天原文没放进来，这是要点，只作参考；和下面从记忆里想起来的对不上时，以这里为准）：\n- 宝宝 10月14日（周三）下午两点面试\]/);
        assert.match(turns.summaries[0]![1]!.content, /阿明：我下周三下午两点面试/);
        // 第二轮：8 轮，切口没挪，同一段要点不再整理
        assert.equal(turns.summaries.length, 1);
        const say = turns.result.steps.find(s => s.kind === 'say')!;
        assert.match(say.generations[0]!.summary!, /下午两点面试/);
        assert.ok(say.generations[0]!.tokens! > 0);
        assert.ok(say.logs.some(l => /较早的聊天原文 8 条不放（事实靠长期记忆和前面的要点）/.test(l)));
        const report = renderReport(turns.result);
        assert.match(report, /原文最近 3 轮 \+ 要点/);
        assert.match(report, /上下文要点：较早的 8 条整理成 1 条/);
        assert.match(report, /生成 1 次（提示词约 \d+ token）/);
    });
});
