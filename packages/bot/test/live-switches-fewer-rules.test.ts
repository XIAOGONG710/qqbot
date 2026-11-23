// 线上一起开着、但从没一起测过的组合（docs/reports/2026-11-24-switch-audit.md「依赖组合」）：fewerRules（ADR 0342，线上 true）
// 和 idioms（口头习惯）、exemplars（真人例子）、deliberate（认真问时深思）。
// 这里把行为钉住：少规矩开着时，这三样的段落都在 RULE_SLOTS 里，被丢掉；
// 口头习惯的后台抽取原来照样调模型（审计说的「只花钱不生效」），11-24 起 fewerRules 开着就不建这个模块、不再调；深思照样换模型（「只剩换模型」），测试名里写明。
// 真的 App（行为基线的 harness：合成角色、假模型、假时钟），只开要看的那一个开关（其余按生产默认），开 / 关 fewerRules 各跑一遍，
// 按提示词指纹清单（槽）和快照正文比。种子和行为基线的 idioms / exemplars 场景同一种写法，只是短。

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { useFewerRules } from '../src/language/fewer-rules.ts';
import { ChatHistory } from '../src/memory/history.ts';
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

/** 以前两周他发了 72 条、常说「笑死」「绝了」（同基线 idioms 场景）；连上后学一次，之后约一半的轮次放进提示词 */
const idioms = (fewerRules: boolean) => scenario({ idioms: true, fewerRules }, [
    ['2026-11-22T19:30:00+08:00', '笑死 今天又迟到了'], ['2026-11-22T19:40:00+08:00', '你吃饭了吗'], ['2026-11-22T19:50:00+08:00', '这个视频绝了'],
    ['2026-11-22T20:00:00+08:00', '周末有空吗'], ['2026-11-22T20:10:00+08:00', '笑死 室友摔了一跤'], ['2026-11-22T20:20:00+08:00', '你在干嘛'],
], {
    seed: (dataDir, start) => {
        const chats = new ChatHistory(dataDir);
        const his = ['今天上课好困', '食堂的饭一般', '刚打完球', '室友又在打游戏', '老师拖堂了', '晚上吃什么', '图书馆人好多', '作业写完了', '明天降温'];
        for (let i = 0; i < 72; i++) {
            const at = start - (14 * 24 - i * 4.5) * 3600_000;
            const said = i % 3 === 0 ? `笑死 ${his[i % his.length]}` : i % 5 === 0 ? `${his[i % his.length]} 绝了` : his[i % his.length]!;
            chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: said, messageId: 300 + i * 2 });
            chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '嗯嗯', messageId: 301 + i * 2 });
        }
    },
    reply: () => (call: LlmCall) => (/口头习惯/.test(text(call.messages.at(-1))) && /JSON/.test(text(call.messages.at(-1)))
        ? '[{"说法":"笑死","类型":"口头禅"},{"说法":"绝了","类型":"网络说法"}]'
        : /JSON|json/.test(text(call.messages.at(-1))) || /JSON|json/.test(text(call.messages[0])) ? '[]' : '嗯嗯'),
});

/** 语料里几条合成的「他说 / 她回」（同基线 exemplars 场景）；男朋友的话和哪条像就放最像的几条 */
const exemplars = (fewerRules: boolean) => scenario({ exemplars: true, fewerRules }, [
    ['2026-11-22T19:30:00+08:00', '吃饭了吗'], ['2026-11-22T19:45:00+08:00', '今天好累啊'], ['2026-11-22T20:00:00+08:00', '晚上吃什么好'],
], {
    seed: dataDir => {
        const row = (id: string, said: string, replied: string[]) => JSON.stringify({ id, source: `synthetic.jsonl|${id}`, license: 'synthetic', said, replied });
        mkdirSync(join(dataDir, 'exemplars'), { recursive: true });
        writeFileSync(join(dataDir, 'exemplars', 'corpus.jsonl'), [
            row('e1', '今天好累啊', ['累就早点歇着', '别硬撑']),
            row('e2', '今天上课好累', ['辛苦啦']),
            row('e3', '吃饭了吗', ['刚吃完', '你呢']),
            row('e4', '晚上吃什么好', ['想吃火锅']),
        ].join('\n') + '\n');
        // 前一天聊过（不是消失几天回来的小别扭）
        const chats = new ChatHistory(dataDir);
        const at = Date.parse('2026-11-21T21:00:00+08:00');
        chats.append(boyfriend.qq, { time: new Date(at).toISOString(), role: 'user', content: '晚安', messageId: 700 });
        chats.append(boyfriend.qq, { time: new Date(at + 60_000).toISOString(), role: 'assistant', content: '晚安', messageId: 701 });
    },
});

/** 认真问她想法（同基线 rich-chat 那一轮） */
const deliberate = (fewerRules: boolean) => scenario({ deliberate: true, fewerRules }, [
    ['2026-11-22T20:30:00+08:00', '认真问你，你觉得我要不要转专业？我最近真的很纠结'],
]);

describe('fewerRules × idioms（ADR 0138）', () => {
    test('关着 fewerRules：口头习惯那段有几轮进了提示词', async () => {
        const r = await run(idioms(false));
        assert.ok(r.slots('idiom') >= 1, '有 idiom 槽');
        assert.ok(r.out.includes('[他平时爱说「笑死」「绝了」'));
    });

    test('开着 fewerRules：口头习惯那段一轮都不进提示词，后台也不调模型学（学了用不上，省掉）', async () => {
        const r = await run(idioms(true));
        assert.ok(r.manifests.length >= 6, '回复照常');
        assert.equal(r.slots('idiom'), 0);
        assert.ok(!r.out.includes('[他平时爱说'));
        assert.ok(!r.out.includes('请找出他说话的**口头习惯**'), '后台抽取不再调模型');
    });
});

describe('fewerRules × exemplars（ADR 0190）', () => {
    test('关着 fewerRules：真人例子有几轮进了提示词', async () => {
        const r = await run(exemplars(false));
        assert.ok(r.slots('exemplar') >= 1, '有 exemplar 槽');
    });

    test('开着 fewerRules：真人例子一轮都不进提示词（线上开着也不生效）', async () => {
        const r = await run(exemplars(true));
        assert.ok(r.manifests.length >= 3, '回复照常');
        assert.equal(r.slots('exemplar'), 0);
    });
});

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
