// 线上一起开着、但从没一起测过的组合（docs/reports/2026-11-24-switch-audit.md「依赖组合」）：fewerRules（ADR 0342，线上 true）和 deliberate（认真问时深思）。
// 这里把行为钉住：少规矩开着时深思那一行在 RULE_SLOTS 里被丢掉，但照样换模型（「只剩换模型」），测试名里写明。
// 原来还钉着 idioms（口头习惯）、exemplars（真人例子）：它们的段落在 fewerRules 下整类不放，11-24 fewerRules 转正时连开关一起删了（减法单子 二.1）。
// 真的 App（行为基线的 harness：合成角色、假模型、假时钟），只开要看的那一个开关（其余按生产默认），开 / 关 fewerRules 各跑一遍，
// 按提示词指纹清单（槽）和快照正文比。

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { useFewerRules } from '../src/language/fewer-rules.ts';
import type { AppConfig, Contact } from '../src/platform/config.ts';
import type { PromptManifest } from '../src/platform/prompt-manifest.ts';
import { runScenario, type LlmCall, type Scenario } from './baseline/harness.ts';

// App 启动时按配置设一次全局的「少规矩」：每条跑完复位，别带到别的测试里
afterEach(() => useFewerRules(false));

const boyfriend: Contact = { qq: 10001, name: '阿明', tier: 'boyfriend', persona: '她的男朋友，同校不同专业', knowsBot: true };
const text = (message: { content?: unknown } | undefined) => (typeof message?.content === 'string' ? message.content : '');

/** 他在这几个时刻各说一句；作息关着（几秒内回），不主动 */
function scenario(config: Partial<AppConfig>, lines: readonly [string, string][], extra: Partial<Scenario> = {}): Scenario {
    return {
        name: 'live-switches-fewer-rules',
        about: '开关组合：fewerRules',
        start: '2026-11-22T19:00:00+08:00',
        contacts: [boyfriend],
        config: { schedule: false, moody: false, proactive: 'off', ...config },
        reply: () => (call: LlmCall) => (/JSON|json/.test(text(call.messages.at(-1))) || /JSON|json/.test(text(call.messages[0])) ? '[]' : '嗯嗯'),
        script: async d => {
            for (const [at, said] of lines) { await d.at(at); d.say(boyfriend.qq, said); }
            await d.wait(10 * 60_000);
        },
        ...extra,
    };
}

/** 跑一遍，收每一轮的清单 */
async function run(s: Scenario) {
    const manifests: PromptManifest[] = [];
    const out = await runScenario({ ...s, manifest: manifest => manifests.push(manifest) });
    const slots = (slot: string) => manifests.filter(m => m.pieces.some(piece => piece.slot === slot)).length;
    return { out, manifests, slots };
}

/** 认真问她想法（同基线 rich-chat 那一轮） */
const deliberate = (fewerRules: boolean) => scenario({ deliberate: true, fewerRules }, [
    ['2026-11-22T20:30:00+08:00', '认真问你，你觉得我要不要转专业？我最近真的很纠结'],
]);

describe('fewerRules × deliberate（ADR 0151）', () => {
    /** 换了深思模型的那次调用（快照里记「换模型」） */
    const switched = (out: string) => out.split('\n').filter(line => /^@ .* llm #\d+ chat model=deepseek-v4-pro .*换模型$/.test(line));

    test('关着 fewerRules：认真问她想法那一轮换深思模型，提示词里有深思那一行', async () => {
        const r = await run(deliberate(false));
        assert.equal(switched(r.out).length, 1, '换了模型');
        assert.equal(r.slots('deliberate'), 1, '有 deliberate 槽');
    });

    test('开着 fewerRules：深思那一行被丢，但照样换深思模型（只剩换模型）', async () => {
        const r = await run(deliberate(true));
        assert.equal(r.slots('deliberate'), 0);
        assert.equal(r.slots('routedHint'), 0);
        assert.equal(switched(r.out).length, 1, '仍然换了模型');
    });
});
