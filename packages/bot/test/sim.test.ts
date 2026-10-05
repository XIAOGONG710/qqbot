import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/config.ts';
import { loadTierCard } from '../src/contact.ts';
import type { MemoryItem, RecallRequest } from '../src/memory/hindsight.ts';
import type { OpenAIMessage } from '../src/prompt.ts';
import { renderReport } from '../src/sim/report.ts';
import { runScenario, type SimHindsight } from '../src/sim/runner.ts';
import { parseDuration, parseScenario, VirtualClock } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
const llm: BotConfig['llm'] = {
    baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
    promptPostProcessing: '', extraBody: {},
};
const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };

describe('模拟器：场景文件', () => {
    test('时长写法', () => {
        assert.equal(parseDuration('9h30m'), 9.5 * 3_600_000);
        assert.equal(parseDuration('1d'), 86_400_000);
        assert.equal(parseDuration('90s'), 90_000);
        assert.throws(() => parseDuration('30'), /时长写法不对/);
        assert.throws(() => parseDuration('1d x'), /时长写法不对/);
    });

    test('场景默认按作息，可以关掉', () => {
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00', steps: [{ say: '在吗' }] };
        assert.equal(parseScenario(base).schedule, true);
        assert.equal(parseScenario({ ...base, schedule: false }).schedule, false);
    });

    test('写错的场景说清楚是哪一步', () => {
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00' };
        assert.throws(() => parseScenario({ ...base, tier: 'friend', steps: [{ say: 'a' }] }), /tier 应为/);
        assert.throws(() => parseScenario({ ...base, steps: [{ say: 'a', advance: '1d' }] }), /第 1 步：要有且只有/);
        assert.throws(() => parseScenario({ ...base, steps: [{ say: 'a', interrupt: { say: 'b', during: 'generation', afterBubbles: 1 } }] }), /interrupt 要有且只有/);
        assert.throws(() => parseScenario({ ...base, steps: [{ advance: '一天' }] }), /时长写法不对/);
        const s = parseScenario({ ...base, steps: [{ say: ['a', 'b'] }] });
        assert.equal(s.user, '阿明');
        assert.equal(s.memory, true);
    });

    test('虚拟时钟 = 真实时间 + 偏移', () => {
        let real = 1000;
        const clock = new VirtualClock(new Date('2026-10-05T20:00:00+08:00'), () => real);
        assert.equal(new Date(clock.now()).toISOString(), '2026-10-05T12:00:00.000Z');
        real += 5000;
        clock.advance(86_400_000);
        assert.equal(new Date(clock.now()).toISOString(), '2026-10-06T12:00:05.000Z');
    });
});

describe('模拟器：跑场景（假模型、假 Hindsight）', () => {
    test('连发合并、生成中插话、发送中途插话、跳一天后的时间块和召回、自动检查、报告', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
        const calls = { retain: [] as MemoryItem[], recall: [] as RecallRequest[], deleted: [] as string[], refreshed: 0 };
        let created = false;
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async (_bank, item) => { calls.retain.push(item); },
            recall: async (_bank, request) => { calls.recall.push(request); return [{ id: '1', text: '阿明的组长外号叫铁锅', document_id: 'ep-old' }]; },
            getMentalModel: async () => (created ? { id: 'relationship', content: '关系稳定' } : undefined),
            createMentalModel: async () => { created = true; },
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => { calls.refreshed++; return 'op-1'; },
            deleteBank: async bank => { calls.deleted.push(bank); },
        };
        const prompts: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => {
            prompts.push(messages);
            await new Promise(r => setTimeout(r, 50));
            return prompts.length === 2 ? '第一条\n第二条\n第三条' : '好';
        };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00',
            steps: [
                { case: 'T07' },
                { say: ['一', '二', '三'], gapMs: 100 },
                { check: { generations: 1 } },
                { case: 'T09' },
                { say: '讲讲你今天', interrupt: { afterBubbles: 1, say: '等下' } },
                { check: { dropped: true, replyNone: ['第三条'] } },
                { case: 'T08' },
                { say: '我今天面试了', interrupt: { during: 'generation', say: '不对，是昨天' } },
                { check: { regenerated: true, generations: 2 } },
                { advance: '1d' },
                { refresh: 'relationship' },
                { say: '铁锅又找我茬' },
                { check: { recall: ['铁锅'], timeBlock: '距上一条消息：1 天', replyAny: ['好'] } },
                { check: { timeBlock: '\\[你现在：国庆节放假，没回青岛，留在学校；.+；阿明回青岛了\\]' } },
                { check: { recall: ['不存在的词'] } },
            ],
        });
        try {
            const result = await runScenario(scenario, {
                runId: 'test', dataDir: dir, card, llm, prompt, hindsight, generate,
                settle: { quietMs: 200, maxMs: 1000 },
            });
            const failed = result.steps.flatMap(s => s.checks).filter(c => !c.ok).map(c => c.text);
            assert.deepEqual(failed, ['召回里有「不存在的词」'], '只有故意写错的那条不通过');

            const t09 = result.steps[4]!;
            assert.deepEqual(t09.bubbles.map(b => b.text), ['第一条', '好'], '第一条之后插话，剩下两条不发，接着回插话');
            assert.deepEqual(t09.inputs.map(i => [i.text, i.interrupt ?? false]), [['讲讲你今天', false], ['等下', true]]);
            // 她发的消息记的是虚拟时间；插话排在第一条之后
            const chat = readFileSync(join(dir, 'chats', '10001.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { time: string; content: string });
            const order = chat.map(m => m.content);
            assert.ok(order.indexOf('等下') === order.indexOf('第一条') + 1);
            assert.ok(chat.every(m => m.time.startsWith('2026-10-05') || m.time.startsWith('2026-10-06')));

            assert.equal(calls.retain.length, 1, '跳一天后前一段结束，写进记忆');
            assert.equal(calls.refreshed, 1);
            assert.equal(result.steps[10]!.relationship, '关系稳定');
            assert.deepEqual(calls.deleted, [result.bankId]);
            assert.match(result.bankId!, /^sim-test-[0-9a-f]{16}$/);

            const report = renderReport(result);
            assert.match(report, /## T09/);
            assert.match(report, /\*\*对方\*\*（插话）：等下/);
            assert.match(report, /发送中途对方插话，剩下 2 条不发/);
            assert.match(report, /❌ 召回里有「不存在的词」/);
            assert.match(report, /10-06 周二/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('挪走聊天记录后只能靠召回；Hindsight 停了照常回复；字数检查', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
        let created = false;
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [{ id: '1', text: '阿明的组长外号叫铁锅', document_id: 'ep-old' }],
            getMentalModel: async () => (created ? { id: 'relationship', content: '' } : undefined),
            createMentalModel: async () => { created = true; },
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            deleteBank: async () => {},
        };
        const seen: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => { seen.push(messages); return '嗯嗯'; };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00',
            steps: [
                { say: '我们组长外号叫铁锅' },
                { advance: '1h' },
                { forget: 'chat' },
                { hindsight: 'down' },
                { say: '在吗' },
                { check: { recall: ['铁锅'] } },
                { hindsight: 'up' },
                { say: '铁锅又找我茬' },
                { check: { recall: ['铁锅'], maxChars: 2, minChars: 2, maxBubbles: 1 } },
            ],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 100, maxMs: 500 } });
            assert.deepEqual(result.steps.flatMap(s => s.checks).map(c => c.ok), [false, true, true, true, true], 'Hindsight 停了那次没有召回');
            assert.deepEqual(result.steps[4]!.bubbles.map(b => b.text), ['嗯嗯'], '停了也照常回复');
            assert.ok(result.steps[4]!.logs.some(l => l.includes('记忆召回失败')));
            // 挪走之后的提示词里没有原文
            const chat = (m: OpenAIMessage[]) => m.filter(x => x.role === 'user').map(x => x.content).join('|');
            assert.equal(chat(seen[1]!), '在吗');
            assert.equal(chat(seen[2]!), '在吗|铁锅又找我茬');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('作息（ADR 0007）：睡着不回、连着发被吵醒一次、wait 等到起床、冷场的延迟按虚拟时间自动拨过去', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
        const states: string[] = [];
        const generate = async (messages: OpenAIMessage[]) => {
            states.push(messages.map(m => m.content).join('\n').match(/\[你现在：[^\]]*\]/)?.[0] ?? '');
            return '嗯\n知道了';
        };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', start: '2026-10-05T03:00:00+08:00', memory: false,
            steps: [
                { say: '在吗' },
                { check: { noReply: true, log: '在睡觉' } },
                { advance: '3m' },
                { say: '醒醒' },
                { check: { log: '吵醒', maxBubbles: 1, replyWithin: '1m' } },
                { say: '你睡了吗' },
                { check: { noReply: true } },
                { wait: 'reply' },
                { check: { replyAfter: '6h', replyWithin: '7h30m' } },
                { advance: '2h' },
                { say: '在干嘛' },
                { check: { replyAfter: '15s', replyWithin: '2m', log: '冷场' } },
            ],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, generate, settle: { quietMs: 100, maxMs: 500 } });
            const failed = result.steps.flatMap(s => s.checks).filter(c => !c.ok).map(c => c.text);
            assert.deepEqual(failed, []);
            assert.match(states[0]!, /被消息震醒了，迷迷糊糊的/);
            assert.doesNotMatch(states[1]!, /震醒/);
            const woke = result.steps[3]!.bubbles;
            assert.deepEqual(woke.map(b => b.text), ['嗯\n知道了'], '被吵醒最多 1 条，多行合在一起');
            // 起床后的回复记在 wait 这一步，在 09:30–10:00
            const morning = new Date(result.steps[7]!.bubbles[0]!.time);
            assert.ok(morning.getHours() === 9 && morning.getMinutes() >= 30, morning.toString());
            const report = renderReport(result);
            assert.match(report, /时间往后走，等她回复/);
            assert.match(report, /在睡觉，起床后看到，\d{2}:\d{2}:\d{2} 看到/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('主动消息（ADR 0011）：虚拟时钟上的一天；他回了早安，下午记下的面试第二天问；检查条数、时间点；报告里标出主动的', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
        let extractions = 0;
        const generate = async (messages: OpenAIMessage[]) => {
            // 抽待跟进的事的请求（system 里写着「待跟进」）：第一次记下明天下午的面试
            if (messages[0]!.content.includes('待跟进')) return extractions++ === 0 ? '{"add":[{"what":"面试","date":"2026-10-13","time":"afternoon"}],"resolved":[]}' : '{"add":[],"resolved":[]}';
            const note = messages.map(m => m.content).join('\n').match(/\[这次是你主动找阿明：([^\]]*)\]/)?.[1];
            return note ? `主动：${note.slice(0, 30)}` : '好';
        };
        const scenario = parseScenario({
            name: '主动', tier: 'boyfriend', start: '2026-10-12T06:00:00+08:00', memory: false, proactive: true,
            // 他每次都回：她主动发的没人回就会停（ADR 0011 确认记录第 2 条）
            steps: [
                { wait: 'proactive' },
                { say: '早，刚醒' },
                { say: '我明天下午有个面试' },
                { wait: 'proactive' },
                { say: '刚下班' },
                { check: { proactive: { count: [2, 2], perDayMax: 2, allowedTimes: true, occasions: ['早安', '下课'], exitClean: true } } },
                { wait: 'proactive' },
                { say: '早' },
                { wait: 'proactive' },
                { check: { proactive: { count: [2, 2], occasions: ['早安', '待跟进的事'], replyAny: ['面试'], perDayMax: 2, allowedTimes: true } } },
            ],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, generate, settle: { quietMs: 50, maxMs: 200 } });
            const failed = result.steps.flatMap(s => s.checks).filter(c => !c.ok).map(c => c.text);
            assert.deepEqual(failed, [], result.steps.flatMap(s => s.logs).filter(l => /主动|待跟进/.test(l)).join('\n'));
            assert.equal(extractions >= 1, true);
            const first = result.steps[0]!.bubbles[0]!;
            assert.equal(first.proactive, '早安');
            const report = renderReport(result);
            assert.match(report, /她（主动：早安）：主动：/);
            assert.match(report, /待跟进：记下「面试」/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
