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
import { runChecks, runScenario, type SimHindsight, type StepRecord } from '../src/sim/runner.ts';
import { loadScenario, parseDuration, parseScenario, sayText, VirtualClock } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const card = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend');
const llm: BotConfig['llm'] = {
    baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
    promptPostProcessing: '', extraBody: {},
};
const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
/** 写日记的请求（ADR 0017），也算上周记、阶段总结（ADR 0018）：假模型单独回，不算进聊天的生成 */
const isDiary = (messages: OpenAIMessage[]) => messages[0]?.role === 'system'
    && (messages[0].content.includes('睡前在写今天') || messages[0].content.includes('的日记，写一段小结'));
/** 抽她答应的事的请求（ADR 0018）：同上 */
const isPromises = (messages: OpenAIMessage[]) => messages[0]?.role === 'system' && messages[0].content.includes('答应过的事」');

describe('模拟器：场景文件', () => {
    test('她和他事先的聊天（ADR 0018）：要早于起点 45 分钟以上；不写是空的', () => {
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-09T21:00:00+08:00', steps: [{ say: '在吗' }] };
        assert.deepEqual(parseScenario(base).history, []);
        const ok = parseScenario({ ...base, history: [{ time: '2026-10-08T21:00:00+08:00', role: 'assistant', content: '下次给你讲' }] });
        assert.deepEqual(ok.history, [{ time: new Date('2026-10-08T21:00:00+08:00').toISOString(), role: 'assistant', content: '下次给你讲' }]);
        assert.throws(() => parseScenario({ ...base, history: [{ time: '2026-10-09T20:30:00+08:00', role: 'user', content: '在吗' }] }), /history\[0\] 要早于起点 45 分钟以上/);
        assert.throws(() => parseScenario({ ...base, history: {} }), /history 应为数组/);
    });

    test('假的图片表情收藏（ADR 0063）：编号 12 位小写十六进制、要有描述、不能重复；检查项 stickerSent / maxStickers 数气泡里单独的编号，并查编号有没有被并进文字', () => {
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-09T21:00:00+08:00', steps: [{ say: '在吗' }] };
        assert.equal(parseScenario(base).stickers, undefined);
        const ok = parseScenario({ ...base, stickers: [{ id: 'a1b2c3d4e5f6', description: ' 橘猫翻白眼 ', tags: ['无语'] }, { id: 'b2c3d4e5f6a7', description: '小熊蹭枕头' }] });
        assert.deepEqual(ok.stickers, [{ id: 'a1b2c3d4e5f6', description: '橘猫翻白眼', tags: ['无语'] }, { id: 'b2c3d4e5f6a7', description: '小熊蹭枕头', tags: [] }]);
        assert.throws(() => parseScenario({ ...base, stickers: [] }), /stickers 应为非空数组/);
        assert.throws(() => parseScenario({ ...base, stickers: [{ id: 'ABC', description: 'x' }] }), /id 应为 12 位小写十六进制/);
        assert.throws(() => parseScenario({ ...base, stickers: [{ id: 'a1b2c3d4e5f6', description: ' ' }] }), /description/);
        assert.throws(() => parseScenario({ ...base, stickers: [{ id: 'a1b2c3d4e5f6', description: 'x' }, { id: 'a1b2c3d4e5f6', description: 'y' }] }), /id 重复/);
        const step = (texts: string[]) => ({ bubbles: texts.map((text, i) => ({ time: i, text })), generations: [], logs: [] }) as unknown as StepRecord;
        const alone = runChecks({ stickerSent: true, maxStickers: 1 }, step(['哈哈', '<sticker:a1b2c3d4e5f6>']));
        assert.deepEqual(alone.map(r => r.ok), [true, true, true], '单独成条：发了、不超过 1 个、编号没被并进文字');
        const merged = runChecks({}, step(['哈哈\n<sticker:a1b2c3d4e5f6>']));
        assert.deepEqual(merged.map(r => r.ok), [false], '并进文字的编号会被当文字发出去');
        assert.equal(runChecks({ stickerSent: false }, step(['哈哈']))[0]!.ok, true);
        assert.equal(runChecks({ stickerSent: false }, step(['<sticker:a1b2c3d4e5f6>']))[0]!.ok, false);
        assert.equal(runChecks({}, step(['哈哈'])).length, 0, '没出现编号时不多出检查项');
    });

    test('新场景文件都读得进来（ADR 0018、0020）', () => {
        for (const name of ['memory-fading', 'her-promises', 'memory-weeks', 'disclosure-boyfriend', 'disclosure-classmate', 'life-events', 'conversation-naturalness', 'promise-vs-topic', 'life-72h-auto', 'long-context-memory', 'boyfriend-intimacy', 'boyfriend-banter', 'photo-ask']) {
            assert.ok(loadScenario(join(repoRoot, `packages/bot/sim/${name}.json`)).steps.length > 0, name);
        }
    });

    test('他发的语音、图片（ADR 0052）：按 bot 进聊天记录的写法变成一行；写错报错', () => {
        const scenario = loadScenario(join(repoRoot, 'packages/bot/sim/media-boyfriend.json'));
        const says = scenario.steps.filter(step => 'say' in step).flatMap(step => [(step as { say: Parameters<typeof sayText>[0] | Parameters<typeof sayText>[0][] }).say].flat()).map(sayText);
        assert.deepEqual(says, [
            '[语音 15秒]', '[语音 9秒：今天下午体测跑了八百米，跑完腿都软了，现在走路都打晃]',
            '我们期中考试时间出来了', '[图片，上面写着：期中考试安排 高等数学 11月12日 上午9:00 地点：知行楼301]', '你看', '[图片]', '[语音 6秒]',
        ]);
        const base = { name: 'x', tier: 'boyfriend', start: '2026-10-09T21:00:00+08:00' };
        assert.throws(() => parseScenario({ ...base, steps: [{ say: [{ voice: '在吗', seconds: 0 }] }] }), /say 应为非空字符串，或数组/);
        assert.throws(() => parseScenario({ ...base, steps: [{ say: [{ image: 1 }] }] }), /say 应为非空字符串，或数组/);
        assert.throws(() => parseScenario({ ...base, steps: [{ say: [{ voice: '在吗', text: 'x' }] }] }), /say 应为非空字符串，或数组/);
    });

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
        assert.throws(() => parseScenario({ ...base, steps: [{ life: { id: 'x', kind: 'feed_cat', result: 'maybe' } }] }), /life.result/);
        assert.throws(() => parseScenario({ ...base, steps: [{ action: { id: 'x', kind: 'teleport' } }] }), /action.kind/);
        const s = parseScenario({ ...base, steps: [{ say: ['a', 'b'] }] });
        assert.equal(s.user, '阿明');
        assert.equal(s.memory, true);
    });

    test('生活事件不经过聊天也能发生、落账并幂等重放', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-life-sim-'));
        const scenario = parseScenario({
            name: '生活事件重放', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00', memory: false,
            steps: [{ life: { id: 'feed-potato', kind: 'feed_cat', seen: true } }],
        });
        try {
            const options = { runId: 'life-replay', dataDir: dir, card, llm, prompt, herDays: true };
            const first = await runScenario(scenario, options);
            const second = await runScenario(scenario, options);
            const events = JSON.parse(readFileSync(join(dir, 'world', 'events.json'), 'utf8')).events;
            const actions = JSON.parse(readFileSync(join(dir, 'world', 'actions.json'), 'utf8')).actions;
            assert.equal(events.length, 1);
            assert.equal(actions.length, 1);
            assert.equal(first.steps[0]!.inputs.length, 0);
            assert.equal(first.steps[0]!.life, 'feed_cat：succeeded');
            assert.equal(second.steps[0]!.life, 'feed_cat：succeeded');
            assert.match(renderReport(first), /生活事件 feed_cat：succeeded/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('类型化行动先排队，结束以后才落进事件账；同一场景重放不重复', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-action-sim-'));
        const scenario = parseScenario({
            name: '行动队列重放', tier: 'boyfriend', start: '2026-10-12T14:00:00+08:00', memory: false,
            steps: [
                { action: { id: 'rest', kind: 'rest', durationMinutes: 30 } },
                { advance: '29m' },
                { advance: '1m' },
            ],
        });
        try {
            const options = { runId: 'action-replay', dataDir: dir, card, llm, prompt, herDays: true };
            const first = await runScenario(scenario, options);
            assert.equal(first.steps[1]!.advance, '29m');
            const events = JSON.parse(readFileSync(join(dir, 'world', 'events.json'), 'utf8')).events;
            assert.equal(events.filter((event: { kind: string }) => event.kind === 'rest').length, 1);
            assert.deepEqual(JSON.parse(readFileSync(join(dir, 'world', 'action-queue.json'), 'utf8')).items, []);
            assert.match(renderReport(first), /类型化行动 rest：planned/);

            await runScenario(scenario, options);
            const replayed = JSON.parse(readFileSync(join(dir, 'world', 'events.json'), 'utf8')).events;
            assert.equal(replayed.filter((event: { kind: string }) => event.kind === 'rest').length, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('autonomous：没人聊天她也一件件过日子，落进事件账；中途重启接着过，和不重启的一样（ADR 0040）', async () => {
        const steps = (restart: boolean) => [
            { advance: '11h' },
            ...(restart ? [{ restart: true as const }] : []),
            // 到第二天 10:00：02:00 睡到 9:30 那一觉已经睡完、落账
            { advance: '15h' },
            { check: { life: {
                atLeast: { sleep: 1, eat: 2, attend_class: 1 }, noOverlap: true, noFailed: true,
                nonRoutinePerDay: { days: ['2026-10-12'], min: 3, max: 8 },
                interruptedAtLeast: { interrupted_by_class: 1 }, statusConsistent: true,
            } } },
        ];
        const scenario = (restart: boolean) => parseScenario({
            name: '自己过日子', tier: 'boyfriend', start: '2026-10-12T08:00:00+08:00', memory: false, autonomous: true, steps: steps(restart),
        });
        const plain = mkdtempSync(join(tmpdir(), 'qqbot-auto-a-'));
        const restarted = mkdtempSync(join(tmpdir(), 'qqbot-auto-b-'));
        try {
            const generate = async () => '嗯';
            const a = await runScenario(scenario(false), { runId: 'auto', dataDir: plain, card, llm, prompt, herDays: true, generate });
            const b = await runScenario(scenario(true), { runId: 'auto', dataDir: restarted, card, llm, prompt, herDays: true, generate });
            assert.deepEqual(a.steps.flatMap(s => s.checks).filter(c => !c.ok), []);
            assert.deepEqual(b.steps.flatMap(s => s.checks).filter(c => !c.ok), []);
            const life = (dir: string) => JSON.parse(readFileSync(join(dir, 'world', 'events.json'), 'utf8')).events
                .filter((event: { id: string }) => event.id.startsWith('life:')).map((event: { id: string; endedAt: string }) => [event.id, event.endedAt]);
            assert.deepEqual(life(restarted), life(plain));
            assert.ok(life(plain).length >= 8);
        } finally {
            rmSync(plain, { recursive: true, force: true });
            rmSync(restarted, { recursive: true, force: true });
        }
    });

    test('检查项：句式、第一句、说了几句；管线自检单独算（DSH 复核 ADR 0036）', () => {
        const step: StepRecord = {
            kind: 'check', time: 0, inputs: [], generations: [{ time: 0, messages: 1, timeBlock: '[这一轮你想：顺着他的话收尾]' }], logs: [], checks: [],
            bubbles: [{ time: 0, text: '去吧去吧' }, { time: 0, text: '写完跟我说一声\n早点睡' }],
        };
        const results = runChecks({
            replyNotMatch: ['(写完|忙完).{0,4}(跟我说|找我)', '记得吃饭'], firstNone: ['土豆'], firstAny: ['去吧'], maxBubbles: 2, maxLines: 2, timeBlock: '收尾',
        }, step);
        assert.deepEqual(results.map(r => [r.ok, Boolean(r.pipeline)]), [[false, false], [true, false], [true, false], [true, false], [true, true], [true, false], [false, false]]);
        assert.match(results[0]!.text, /「写完跟我说」/);
        assert.match(results.at(-1)!.text, /实际 3 句，发成 2 条/);
    });

    test('清理后为空、重新生成算回复检查不过，报告头单列次数（DSH 复核 ADR 0036 P1-5）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-empty-'));
        let calls = 0;
        // 第一次回的全是行首括号里的动作（卡上的正则清掉），清理后为空；第二次正常
        const generate = async () => (++calls === 1 ? '（揉了揉眼睛）' : '好');
        const scenario = parseScenario({
            name: '清理后为空', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00', memory: false, schedule: false,
            steps: [{ say: '在吗' }, { check: { emptied: false, generations: 1 } }, { say: '睡了没' }, { check: { emptied: false } }],
        });
        try {
            const result = await runScenario(scenario, { runId: 'empty', dataDir: dir, card, llm, prompt, generate, settle: { quietMs: 50, maxMs: 200 } });
            const [first, second] = [result.steps[1]!.checks, result.steps[3]!.checks];
            assert.deepEqual(first.map(c => [c.ok, Boolean(c.pipeline)]), [[false, true], [false, false]]);
            assert.match(first[1]!.text, /实际 1 次/);
            assert.deepEqual(second.map(c => c.ok), [true]);
            assert.deepEqual(result.checks.reply, { passed: 1, failed: 1 });
            assert.match(renderReport(result), /生成 3 次，出口检查重写 0、删行 0，清理后为空 1/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
        const calls = { retain: [] as MemoryItem[], retainBanks: [] as string[], recall: [] as RecallRequest[], deleted: [] as string[], refreshed: 0 };
        const created = new Set<string>();
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async (bank, item) => { calls.retain.push(item); calls.retainBanks.push(bank); },
            recall: async (_bank, request) => { calls.recall.push(request); return [{ id: '1', text: '阿明的组长外号叫铁锅', document_id: 'ep-old' }]; },
            getMentalModel: async (_bank, id) => (created.has(id) ? { id, content: id === 'relationship' ? '关系稳定' : '' } : undefined),
            createMentalModel: async (_bank, request) => { created.add(request.id); },
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => { calls.refreshed++; return 'op-1'; },
            deleteBank: async bank => { calls.deleted.push(bank); },
        };
        const prompts: OpenAIMessage[][] = [];
        const diaries: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => {
            if (isDiary(messages)) { diaries.push(messages); return '今天没什么事，看了会儿书。'; }
            if (isPromises(messages)) return '{"add":[],"resolved":[]}';
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
                { check: { timeBlock: '\\[你现在：国庆节放假，没抢到回青岛的票，留在学校（你们说好以后放假一起走，这次你不难受）；.+；阿明回青岛过国庆了（放假前就说好的）\\]' } },
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

            const isDiaryItem = (item: MemoryItem) => item.metadata?.source === 'diary';
            // 她自己写的：日记、周记、阶段总结（ADR 0018）
            const isHers = (item: MemoryItem) => ['diary', 'week', 'phase'].includes(item.metadata?.source ?? '');
            assert.deepEqual(calls.retainBanks.filter((_, i) => !isHers(calls.retain[i]!)), [result.bankId, 'sim-test-common'], '跳一天后前一段结束，写进记忆（自己的 bank 和公共库，ADR 0016）');
            // 日记（ADR 0017）：起点补写前 3 天，跳过 10-05 之后写 10-05 那篇，都进公共库；10-05 那篇的材料里有那天的聊天
            assert.deepEqual(calls.retain.filter(isDiaryItem).map(item => item.document_id), ['diary:2026-10-02', 'diary:2026-10-03', 'diary:2026-10-04', 'diary:2026-10-05']);
            assert.ok(calls.retainBanks.every((bank, i) => !isHers(calls.retain[i]!) || bank === 'sim-test-common'));
            // 跳到 10-06（周二）：上周 9-28 到 10-04 有 10-02 到 10-04 三篇日记，写周记
            assert.deepEqual(calls.retain.filter(item => item.metadata?.source === 'week').map(item => item.document_id), ['week:2026-09-28']);
            const daily = diaries.filter(messages => messages[0]!.content.includes('睡前在写今天'));
            assert.match(daily[3]![1]!.content, /\[和阿明\]\n.*阿明：一/);
            assert.match(daily[0]![1]!.content, /今天没和名单里的人聊天/);
            assert.equal(calls.refreshed, 1);
            assert.equal(result.steps[10]!.relationship, '关系稳定');
            assert.deepEqual(calls.deleted, [result.bankId, 'sim-test-common']);
            assert.match(result.bankId!, /^sim-test-[0-9a-f]{16}$/);

            const report = renderReport(result);
            assert.match(report, /## T09/);
            assert.match(report, /\*\*对方\*\*（插话）：等下/);
            assert.match(report, /发送中途对方插话，剩下 2 条不发/);
            assert.match(report, /❌ 〔管线〕召回里有「不存在的词」/);
            assert.match(report, /10-06 周二/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('约好的见面（ADR 0047）：片段结束后抽出几点在哪，到点时状态行写她在赴约，不再是作息里的事', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
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
        const seen: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => {
            if (isDiary(messages)) return '日记';
            if (isPromises(messages)) return '{"add":[{"what":"和他去东门吃麻辣烫","date":"2026-10-16","meet":{"time":"18:00","where":"东门口"}}],"resolved":[]}';
            seen.push(messages);
            return seen.length === 1 ? '行啊 六点东门口' : '谁让你点特辣的';
        };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', user: '宝宝', start: '2026-10-16T16:00:00+08:00',
            steps: [{ say: '晚上一起去吃东门那家麻辣烫吧' }, { advance: '2h20m' }, { say: '这家辣椒放得也太狠了吧' }],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 100, maxMs: 500 } });
            const text = (messages: OpenAIMessage[]) => messages.map(m => m.content).join('\n');
            assert.doesNotMatch(text(seen[0]!), /\[你现在：[^\]]*约好的/);
            assert.match(text(seen[1]!), /\[你现在：[^\]]*约好的：和他去东门吃麻辣烫（18:00，东门口），正在赴约；见了面你们也在 QQ 上打字说话/);
            assert.doesNotMatch(text(seen[1]!), /还没做的事：和他去东门吃麻辣烫/, '赴约时不再当成还没做的事提醒');
            assert.match(result.steps.at(-1)!.logs.join('\n'), /此刻在做：约好的/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('她答应的事（ADR 0018）：那段聊天结束后抽出来，他下次来时时间块里提醒', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
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
        const seen: OpenAIMessage[][] = [];
        const extractions: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => {
            if (isDiary(messages)) return '日记';
            if (isPromises(messages)) {
                extractions.push(messages);
                return '{"add":[{"what":"给他讲那本书的结局","date":null}],"resolved":[]}';
            }
            seen.push(messages);
            return seen.length === 1 ? '下次给你讲结局' : '在呢';
        };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00', schedule: false,
            steps: [{ say: '那本书结局是啥' }, { advance: '1h' }, { say: '在吗' }],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 100, maxMs: 500 } });
            assert.equal(extractions.length, 1);
            assert.match(extractions[0]![1]!.content as string, /下次给你讲结局/);
            const text = (messages: OpenAIMessage[]) => messages.map(m => m.content).join('\n');
            assert.doesNotMatch(text(seen[0]!), /答应过/);
            assert.match(text(seen[1]!), /你之前答应过阿明、还没做的事：给他讲那本书的结局（今天说的，说下次）/);
            assert.ok(result.steps.at(-1)!.logs.includes('时间块里提醒了她答应的事'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('挂着的事（ADR 0023）：同一次抽取记下；第二天晚上意图行问结果，心情后面一行只给没了结的事实', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
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
        const seen: OpenAIMessage[][] = [];
        let extracted = 0;
        const generate = async (messages: OpenAIMessage[]) => {
            if (isDiary(messages)) return '日记';
            if (isPromises(messages)) {
                extracted++;
                return extracted === 1
                    ? JSON.stringify({ add: [], waiting: [{ what: '阿明周二下午字节面试', date: '2026-10-06' }], unsettled: [{ what: '10月5日说好一起看电影，他加班没去成' }], resolved: [] })
                    : '{"add":[],"resolved":[]}';
            }
            seen.push(messages);
            return '在呢';
        };
        const scenario = parseScenario({
            name: '测试', tier: 'boyfriend', start: '2026-10-05T20:00:00+08:00', schedule: false,
            steps: [{ say: '明天下午我去字节面试' }, { advance: '1h' }, { advance: '1d' }, { say: '在吗' }],
        });
        try {
            const result = await runScenario(scenario, { runId: 'test', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 100, maxMs: 500 } });
            const text = (messages: OpenAIMessage[]) => messages.map(m => m.content).join('\n');
            assert.doesNotMatch(text(seen[0]!), /这一轮你想：知道/);
            assert.match(text(seen[1]!), /\[这一轮你想：知道「阿明周二下午字节面试」后来怎么样了，随口问一句；他不想说就算了，不追问\]/);
            assert.match(text(seen[1]!), /\[你心里还记着、没了结的事（跨天只记客观事实，不保存情绪，也不是要你说的话）：10月5日说好一起看电影，他加班没去成。这件事让此刻的语气留一点余波，不必装作完全没发生；不用特意提，也不翻旧账/);
            assert.ok(result.steps.at(-1)!.logs.includes('挂着的事：等结果 1、没回答 0、没了结 1'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('挪走聊天记录后只能靠召回；Hindsight 停了照常回复；字数检查', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-'));
        const created = new Set<string>();
        const hindsight: SimHindsight = {
            putBank: async () => {},
            retain: async () => {},
            recall: async () => [{ id: '1', text: '阿明的组长外号叫铁锅', document_id: 'ep-old' }],
            getMentalModel: async (_bank, id) => (created.has(id) ? { id, content: '' } : undefined),
            createMentalModel: async (_bank, request) => { created.add(request.id); },
            updateMentalModel: async () => {},
            activeOperations: async () => [],
            operationStatus: async () => 'completed',
            refreshMentalModel: async () => 'op-1',
            deleteBank: async () => {},
        };
        const seen: OpenAIMessage[][] = [];
        const generate = async (messages: OpenAIMessage[]) => (isDiary(messages) ? '日记' : isPromises(messages) ? '{"add":[],"resolved":[]}' : (seen.push(messages), '嗯嗯'));
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

    test('长上下文场景（DSH 复核 ADR 0036 P2-8）：开场就超过 80 条；她照抄事先聊天里的收尾，每一轮 noRepeat 都不过', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-sim-long-'));
        const hindsight: SimHindsight = {
            putBank: async () => {}, retain: async () => {}, recall: async () => [],
            getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {},
            activeOperations: async () => [], operationStatus: async () => 'completed', refreshMentalModel: async () => 'op-1', deleteBank: async () => {},
        };
        const prompts: OpenAIMessage[][] = [];
        // 每次都回事先聊天里她说过的那句收尾
        const generate = async (messages: OpenAIMessage[]) => (isDiary(messages) ? '日记' : isPromises(messages) ? '{"add":[],"resolved":[]}' : (prompts.push(messages), '去吧去吧，别熬太晚了啊'));
        try {
            const scenario = loadScenario(join(repoRoot, 'packages/bot/sim/long-context-memory.json'));
            const result = await runScenario(scenario, { runId: 'long', dataDir: dir, card, llm, prompt, hindsight, generate, settle: { quietMs: 50, maxMs: 200 } });
            const all = result.steps.flatMap(s => s.checks);
            assert.ok(all.some(c => c.pipeline && c.ok && c.text.includes('较早的聊天原文')), '开场就有原文不放');
            const repeats = all.filter(c => c.text.startsWith('没把这次运行里说过的话再说一遍'));
            assert.equal(repeats.length, 9);
            assert.ok(repeats.every(c => !c.ok && c.text.includes('前面的「别熬太晚」')));
            // 放进提示词的原文最多 80 条（ADR 0036 决策 3）：10-07 说的面试不在里面
            const said = (m: OpenAIMessage[]) => m.map(x => x.content).join('\n');
            assert.ok(!said(prompts[0]!).includes('下周三下午两点有个面试'));
            assert.ok(said(prompts[0]!).includes('电饭锅煮糊了'));
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
