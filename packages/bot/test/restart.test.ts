import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseScenario, type Step } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const card = loadTierCard(syntheticCardPattern, 'boyfriend');
const llm: BotConfig['llm'] = {
    baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
    promptPostProcessing: '', extraBody: {},
};
const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
const isDiary = (messages: OpenAIMessage[]) => messages[0]?.role === 'system'
    && (messages[0].content.includes('睡前在写今天') || messages[0].content.includes('的日记，写一段小结'));
const isPromises = (messages: OpenAIMessage[]) => messages[0]?.role === 'system' && messages[0].content.includes('答应过的事」');

const hindsight: SimHindsight = {
    putBank: async () => {},
    retain: async () => {},
    recall: async () => [],
    getMentalModel: async () => undefined,
    createMentalModel: async () => {},
    updateMentalModel: async () => {},
    activeOperations: async () => [],
    operationStatus: async () => 'completed',
    refreshMentalModel: async () => 'op-1',
    deleteBank: async () => {},
};

/** 跑一遍，记下每次聊天生成的提示词；假模型的回复只看他最后一句，重放得到一样的 */
async function run(steps: Step[], dir: string): Promise<{ prompts: string[]; logs: string[] }> {
    const prompts: string[] = [];
    const generate = async (messages: OpenAIMessage[]) => {
        if (isDiary(messages)) return '今天没什么事。';
        if (isPromises(messages)) {
            const episode = messages.map(m => m.content).join('\n');
            return episode.includes('下次给你讲')
                ? '{"add":[{"what":"给他讲《三体》第三部的结局","date":null}],"resolved":[]}'
                : '{"add":[],"resolved":[]}';
        }
        prompts.push(JSON.stringify(messages));
        const last = String(messages.at(-1)?.content ?? '');
        return last.includes('结局') ? '下次给你讲' : '嗯';
    };
    const scenario = parseScenario({ name: '重启一致', tier: 'boyfriend', start: '2026-10-19T19:30:00+08:00', steps });
    const result = await runScenario(scenario, {
        runId: 'restart', dataDir: dir, card, llm, prompt, hindsight, generate, herDays: true,
        // 真实时间冻住（两遍的消息时刻一样，lengthHint 按消息的毫秒掷骰子）。不开连发合并（每步一句话，用不着）：
        // 回复器等连发停下来是用真实的 sleep 等、拿虚拟的 now 判断，冻住就永远等不到；不传 settle 会用默认的
        realNow: () => 0,
        settle: { quietMs: 0, maxMs: 0 },
    });
    return { prompts, logs: result.steps.flatMap(step => step.logs) };
}

/** 两份提示词第一处不一样的地方，前后各带一点（整份太长，看不出差在哪） */
function firstDifference(actual: string, expected: string): string | undefined {
    if (actual === expected) return undefined;
    let i = 0;
    while (i < actual.length && actual[i] === expected[i]) i++;
    return `重启后：…${actual.slice(Math.max(0, i - 80), i + 200)}…\n不重启：…${expected.slice(Math.max(0, i - 80), i + 200)}…`;
}

describe('重启一致（ADR 0039）', () => {
    test('同一场景中途重启和不重启，之后每一轮的提示词一样', async () => {
        const steps: Step[] = [
            { say: '在干嘛' },
            { say: '林小满最近咋样' },
            { restart: true },
            { say: '她好了没' },
            { say: '初中那会儿你是不是天天抄我数学作业' },
            { restart: true },
            { say: '那后来呢' },
            // 排了一个小时的学习，还没结束就重启：队列从 action-queue.json 读回来，到点照常落账（ADR 0038 的重启恢复）
            { action: { id: 'study', kind: 'study', durationMinutes: 60 } },
            { restart: true },
            { life: { id: 'feed', kind: 'feed_cat', seen: true } },
            { advance: '1d' },
            { say: '昨天干嘛了' },
            { say: '那三体结局是啥，快讲讲' },
            { advance: '1d' },
            { restart: true },
            { say: '在吗' },
            { advance: '2h' },
            { say: '你那快递拿了没' },
        ];
        const plain = mkdtempSync(join(tmpdir(), 'qqbot-restart-a-'));
        const restarted = mkdtempSync(join(tmpdir(), 'qqbot-restart-b-'));
        try {
            const a = await run(steps.filter(step => !('restart' in step)), plain);
            const b = await run(steps, restarted);
            assert.equal(b.logs.filter(line => line.startsWith('重启：')).length, 4);
            assert.equal(a.prompts.length, b.prompts.length);
            for (const [i, prompt] of a.prompts.entries()) assert.equal(firstDifference(b.prompts[i]!, prompt), undefined, `第 ${i + 1} 次生成`);
            const events = (dir: string) => readFileSync(join(dir, 'world', 'events.json'), 'utf8');
            assert.equal(events(restarted), events(plain));
            assert.match(events(restarted), /"kind": "study"/);
            assert.deepEqual(JSON.parse(readFileSync(join(restarted, 'world', 'action-queue.json'), 'utf8')).items, []);
        } finally {
            rmSync(plain, { recursive: true, force: true });
            rmSync(restarted, { recursive: true, force: true });
        }
    });
});
