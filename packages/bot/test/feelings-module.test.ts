import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { contributeTurn, type Turn, type TurnFacts } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { feelingsModule } from '../src/modules/feelings.ts';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 心境那一行（ADR 0102）、节奏（2026-10-30）、梦那一行（2026-10-31）迁成模块（ADR 0336「心境这一组」第 3、4 步）：
// 三行都在联系人流水线原位算（读梦、作者写下的事、回想过的感受、带结算的世界账，要等小别扭是否生效），写进 turn.facts，模块只放 feeling、pace、dreams 三个槽。
// 行为基线管 App 那一路（feeling 17 个场景、pace 只有 feelings、dreams 19 个场景）；这里管模块本身和模拟器那一路。

type FeelingsFacts = TurnFacts;

const FEELING = '[你此刻的心境（有来由的，不是演的）：很难过（高数小测没考好）。话少，回得慢一点，人是低的。不用解释自己的状态，也别每句都带情绪；事实以上面写的为准，没写的别编]';
const PACE = '（你这会儿提不起劲：话少一点，别硬开玩笑，也别写长句；不想接就只回一句）';
const DREAM = '[你昨晚做了个梦：梦见在电影院门口等他。（醒来心里有点闷）。那是梦，不是真的事；想跟他说就提一句，不想说就搁着]';

describe('心境模块（ADR 0102 / 0336）', () => {
    const at = new Date('2026-12-09T09:30:00+08:00');
    const turnOf = (facts: FeelingsFacts = {}, patch: Partial<Turn> = {}): Turn => ({
        contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '在吗', time: at.toISOString() }], thinking: false, facts, ...patch,
    });
    const run = (t: Turn) => feelingsModule().contribute!(t) as Piece[];

    test('旧逻辑什么都没写（关着、同学档、危机、小别扭生效、没有明显的感受）：什么都不放', () => {
        assert.deepEqual(run(turnOf()), []);
        assert.deepEqual(run(turnOf({ feelingLine: '', paceLine: '', dreamLine: '' })), [], '空串当没有（迁移前按真假判断）');
    });

    test('三行各进各的槽，原文照放', () => {
        assert.deepEqual(run(turnOf({ feelingLine: FEELING, paceLine: PACE, dreamLine: DREAM })), [
            { slot: 'feeling', text: FEELING },
            { slot: 'pace', text: PACE },
            { slot: 'dreams', text: DREAM },
        ]);
        assert.deepEqual(run(turnOf({ dreamLine: DREAM })), [{ slot: 'dreams', text: DREAM }], '只有梦（心境里没有明显的感受）');
        assert.deepEqual(run(turnOf({ feelingLine: FEELING })), [{ slot: 'feeling', text: FEELING }], '有心境、说话的量不用变');
    });

    test('条件都在算的地方：只想一想、主动找他、facts 里写着小别扭生效也照放（迁移前这三行都不看这些，挡在两处变异只能抓到一处）', () => {
        const facts: FeelingsFacts = { feelingLine: FEELING, paceLine: PACE, dreamLine: DREAM };
        const all = [{ slot: 'feeling', text: FEELING }, { slot: 'pace', text: PACE }, { slot: 'dreams', text: DREAM }];
        assert.deepEqual(run(turnOf(facts, { thinking: true })), all);
        assert.deepEqual(run(turnOf(facts, { initiate: { note: '[想他了，找他说句话]', topic: '想他' } })), all);
        assert.deepEqual(run(turnOf({ ...facts, grievanceActive: true })), all);
    });

    test('同步返回：不多等一个微任务（行为基线核对事件顺序）；「此刻」块里心境在节奏前面，梦在两者后面', () => {
        const assembled = contributeTurn([feelingsModule()], turnOf({ feelingLine: FEELING, paceLine: PACE, dreamLine: DREAM }));
        assert.ok(!(assembled instanceof Promise));
        assert.deepEqual(assembled.afterMain, []);
        assert.deepEqual(assembled.afterHistory, [[FEELING, PACE, DREAM].join('\n')]);
    });
});

// 模拟器那一路（场景的 herFeelings + moments）：行为基线碰不到；模拟器的联系人流水线不再放这几行之后，没挂模块这条就报错
describe('模拟器挂着心境的模块（ADR 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const run = async (said: string, patch: { herFeelings?: boolean; tier?: string } = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-feelings-sim-'));
        const prompts: string[] = [];
        try {
            await runScenario(parseScenario({
                name: 'feelings', tier: patch.tier ?? 'boyfriend', start: '2026-12-09T09:30:00+08:00', memory: false, schedule: false,
                ...(patch.herFeelings === false ? {} : { herFeelings: true }),
                // 作者写下的事：一小时前高数小测没考好（很重）——心境「很难过」、节奏「提不起劲」
                moments: [{ id: 'quiz', at: '-1h', kind: 'sad', strength: 3, cause: '高数小测没考好' }],
                steps: [{ say: said }, { advance: '10m' }],
            }), {
                runId: 'feelings', dataDir: dir, card, llm, prompt, settle: { quietMs: 10, maxMs: 50 },
                generate: async messages => {
                    prompts.push(messages.map(m => String(m.content)).join('\n'));
                    return '嗯嗯';
                },
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        return prompts;
    };

    test('开着心境：作者写下的事让她很难过——提示词里有心境那一行和「提不起劲」那一句；关着就都没有', async () => {
        const on = await run('在吗');
        assert.ok(on.length >= 1);
        assert.match(on[0]!, /你此刻的心境（有来由的，不是演的）：很难过（高数小测没考好）/);
        assert.ok(on[0]!.includes(PACE), on[0]);
        const off = await run('在吗', { herFeelings: false });
        assert.ok(off.length >= 1);
        assert.doesNotMatch(off[0]!, /你此刻的心境/);
        assert.ok(!off[0]!.includes(PACE));
    });
});
