import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULTS } from '../src/platform/config.ts';
import { renderGroupRun, runGroupScenario, type GroupScenario } from '../src/sim/group-runner.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 群聊模拟（ADR 0341 G0）：用假模型跑一遍，确认剧本能驱动真实的 App、她开口和不开口都记得下来（真模型在有 key 的机器上跑）
const base = {
    llm: { baseUrl: 'http://127.0.0.1:9', model: 'sim-test', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi' as const, extraBody: {} },
    prompt: { ...DEFAULTS.prompt, maxContext: 16384, pinExamples: true } as never,
};

describe('群聊模拟', () => {
    test('有人 @ 她：她开口一次（mentioned），说的话记进群聊；没人叫她的那批只看不说', async () => {
        const scenario: GroupScenario = {
            about: '合成：先闲聊，再有人 @ 她',
            group: { name: '合成宿舍群' },
            boyfriend: '阿明',
            members: ['老王', '陈陈'],
            steps: [
                { from: '老王', say: '明天的课谁去', pause: 2 },
                { from: '陈陈', say: '@全体 收作业了', pause: 2 },
                { from: '老王', say: '你作业写完没', atHer: true, pause: 0.1 },
            ],
        };
        const prompts: string[] = [];
        const run = await runGroupScenario(scenario, {
            base, characterCard: syntheticCardPattern, idleMs: 2500, maxWaitMs: 15_000,
            generate: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return '写完了，明早交'; },
        });
        assert.equal(run.spoke, 1, run.logs.join('\n'));
        assert.deepEqual(run.reasons, { mentioned: 1 });
        assert.deepEqual(run.lines.filter(line => line.mine).map(line => line.text), ['写完了，明早交']);
        assert.equal(run.lines.filter(line => !line.mine).length, 3);
        assert.ok(prompts.some(p => p.includes('你作业写完没')), '群记录进了提示词');
        const page = renderGroupRun(scenario, run);
        assert.match(page, /她开口 1 次（mentioned 1）/);
        assert.match(page, /\*\*她\*\*：写完了，明早交/);
        const reply = run.decisions.find(decision => decision.reason === 'mentioned');
        assert.equal(reply?.messageId, 6002);
        assert.equal(reply?.replyTargetId, 6002);
        assert.deepEqual(reply?.deliveries, [{ messageId: 9000, replyTo: 6002 }]);
        assert.match(page, /来源 6002 · 目标 6002 · 实际引用 6002 · 发送 1 条/);
        assert.doesNotMatch(page.split('## 接话回放')[1]!.split('## 日志')[0]!, /你作业写完没|写完了，明早交/);
    });

    test('插话抽签按消息编号定：换一组编号，同一句话会抽到不同的签（多次跑才不是同一次重复）', async () => {
        const scenario: GroupScenario = {
            about: '合成：聊到她熟的，没人叫她', group: { name: '合成宿舍群' }, boyfriend: '阿明', members: ['老王'],
            steps: [{ from: '老王', say: '学校门口新开了家奶茶店，好喝吗', pause: 0.1 }],
        };
        const options = { base, characterCard: syntheticCardPattern, idleMs: 2500, maxWaitMs: 15_000, generate: async () => '我喝过，芋泥那款还行' };
        const missed = await runGroupScenario(scenario, { ...options, firstMessageId: 6000 }); // 签 709，过不了 30%
        const hit = await runGroupScenario(scenario, { ...options, firstMessageId: 6102 }); // 签 154
        assert.equal(missed.spoke, 0, missed.logs.join('\n'));
        assert.deepEqual(hit.reasons, { topic: 1 }, hit.logs.join('\n'));
    });

    test('剧本里的人不在群友名单里：直接报错', async () => {
        await assert.rejects(runGroupScenario({ about: '', group: { name: 'x' }, boyfriend: '阿明', members: [], steps: [{ from: '路人', say: '在吗' }] },
            { base, characterCard: syntheticCardPattern }), /不在 boyfriend \/ members 里/);
    });
});
