import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULTS, type BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import {
    auditableText, auditMessages, auditRules, checkFacts, dropClaimLines, dropTooMuch, FACT_CHECK_MODES, FACT_MAX_CLAIMS, factRewriteNote, parseClaims,
    type FactCheckOptions, type FactRecord,
} from '../src/language/fact-check.ts';
import type { OpenAIMessage } from '../src/language/prompt.ts';
import { renderReport } from '../src/sim/report.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0137：逐条事实检查。审稿员（模型）的输出用假的；这里测拼提示词、解析、按档位处理
const names = { user: '阿明', char: '测试角色' };
const claim = (quote: string, kind: 'contradicts' | 'invented' | 'about-him' = 'invented', why = '') => ({ quote, kind, why });
const json = (...claims: ReturnType<typeof claim>[]) => JSON.stringify(claims);

describe('审稿的输入输出', () => {
    test('auditableText：表情包 / 照片指令行不查；不到 6 个字不查；标点和空白不算字', () => {
        assert.equal(auditableText('哈哈'), '');
        assert.equal(auditableText('嗯嗯好的～！！'), '');
        assert.equal(auditableText('<sticker:0123456789ab>'), '');
        assert.equal(auditableText('我刚喂完团子饼\n<sticker:0123456789ab>'), '我刚喂完团子饼');
        assert.equal(auditableText('  我刚喂完团子饼  \n\n 它跑了 '), '我刚喂完团子饼\n它跑了');
    });

    test('auditMessages：设定和事实只放 system（太短的分隔不放），聊天按名字标出来，最后是她的回复', () => {
        const source: OpenAIMessage[] = [
            { role: 'system', content: '测试角色是个大二女生，养了一只叫团子饼的猫。' },
            { role: 'system', content: '[Start a new Chat]' },
            { role: 'system', content: '短' },
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在呢' },
            { role: 'system', content: '[当前时间：晚上八点；你现在在逛淘宝；团子饼今天没下楼]' },
        ];
        const [rules, body] = auditMessages(source, '团子饼一见我就跑', names);
        assert.equal(rules!.role, 'system');
        assert.match(rules!.content, /contradicts/);
        assert.match(rules!.content, /invented/);
        assert.equal(body!.role, 'user');
        const text = body!.content;
        assert.ok(text.includes('测试角色是个大二女生') && text.includes('你现在在逛淘宝；团子饼今天没下楼'));
        assert.ok(!text.includes('Start a new Chat'));
        assert.match(text, /阿明：在吗\n测试角色：在呢/);
        assert.match(text, /## 她准备发出去的回复\n团子饼一见我就跑$/);
    });

    test('parseClaims：容忍代码块和前后废话；类型不对的、回复里没有的片段、太短的丢掉；最多采信 FACT_MAX_CLAIMS 条', () => {
        const reply = '团子饼一见我就跑\n我刚放下手机\n我室友买了奶茶\n它还回头看我\n我去洗澡了';
        const raw = '```json\n' + json(claim('团子饼一见我就跑'), claim('我刚放下手机', 'contradicts', '事实写她在逛淘宝')) + '\n```\n以上。';
        assert.deepEqual(parseClaims(raw, reply), [claim('团子饼一见我就跑'), claim('我刚放下手机', 'contradicts', '事实写她在逛淘宝')]);
        assert.deepEqual(parseClaims('前面一句话 ' + json(claim('我室友买了奶茶')) + ' 后面一句', reply), [claim('我室友买了奶茶')]);
        assert.deepEqual(parseClaims(json(claim('回复里根本没有这句')), reply), [], '照抄不出来的当没说');
        assert.deepEqual(parseClaims(json(claim('我')), reply), [], '一个字的片段太短');
        assert.deepEqual(parseClaims('[{"quote":"团子饼一见我就跑","kind":"vague"}]', reply), [], 'kind 不对');
        assert.deepEqual(parseClaims('[]', reply), []);
        assert.deepEqual(parseClaims('没有问题', reply), []);
        assert.deepEqual(parseClaims('[{"quote":', reply), [], '坏 JSON');
        assert.deepEqual(parseClaims('{"quote":"团子饼一见我就跑","kind":"invented"}', reply), [], '不是数组');
        const many = parseClaims(json(...['团子饼一见我就跑', '我刚放下手机', '我室友买了奶茶', '它还回头看我', '我去洗澡了'].map(q => claim(q))), reply);
        assert.equal(many.length, FACT_MAX_CLAIMS);
    });

    test('factRewriteNote / dropClaimLines', () => {
        const note = factRewriteNote([claim('团子饼一见我就跑', 'invented', '事实里只有它没下楼'), claim('我刚放下手机', 'contradicts')]);
        assert.match(note, /「团子饼一见我就跑」是上面事实里没有的（事实里只有它没下楼）/);
        assert.match(note, /「我刚放下手机」和上面写的事实对不上/);
        assert.match(note, /别添上面没写的小动作/);
        assert.equal(dropClaimLines('在逛淘宝\n团子饼一见我就跑', [claim('团子饼一见我就跑')]), '在逛淘宝');
        assert.equal(dropClaimLines('团子饼一见我就跑', [claim('团子饼一见我就跑')]), '团子饼一见我就跑', '删完一行不剩就原样');
        // dropTooMuch：删完剩下不到一半才算“想说的被删了”；两行删一行不算，只删一句里的旧梗不算
        assert.equal(dropTooMuch('哈哈行，卤蛋记账上了\n不过蛋记得留', [claim('哈哈行，卤蛋记账上了'), claim('不过蛋记得留')]), true);
        assert.equal(dropTooMuch('作业写完了\n那这事我可就记上了', [claim('作业写完了')]), false, '两行删一行还剩一半');
        assert.equal(dropTooMuch('作业写完了\n泡面也吃完了\n那这事我可就记上了', [claim('作业写完了'), claim('泡面也吃完了')]), true);
        assert.equal(dropTooMuch('就一句', [claim('就一句')]), false, '单行不判（dropClaimLines 会原样返回）');
        assert.deepEqual(FACT_CHECK_MODES, ['off', 'log', 'fix']);
    });
});

describe('第三类 about-him：她替他说的、没有依据的事（ADR 0203，factHim）', () => {
    test('默认关', () => {
        assert.equal(DEFAULTS.factHim, false);
    });

    test('auditRules：默认只有前两类和原来的输出说明；开着时多一段第三类 + 不该列的几种 + 输出说明里多了 about-him，原来的输出说明只出现一次', () => {
        const off = auditRules(false);
        assert.ok(!off.includes('about-him'));
        const on = auditRules(true);
        assert.ok(on.startsWith(off.slice(0, 200)), '前两类的规则原样');
        assert.match(on, /第三类，关于【他本人】/);
        assert.match(on, /从这次聊天里直接看得出来的观察/);
        assert.match(on, /"kind":"contradicts" 或 "invented" 或 "about-him"/);
        assert.equal(on.split('只输出一个 JSON 数组').length - 1, 1);
        assert.equal(auditMessages([{ role: 'user', content: '在吗' }], '嗯嗯好的呀', names)[0]!.content, off);
        assert.equal(auditMessages([{ role: 'user', content: '在吗' }], '嗯嗯好的呀', names, { aboutHim: true })[0]!.content, on);
    });

    test('parseClaims：没开 aboutHim 时模型给的 about-him 当没说；开着才采信', () => {
        const raw = json(claim('你数学不差', 'about-him', '他没说过'), claim('团子饼跑过来', 'invented'));
        const reply = '你数学不差\n团子饼跑过来';
        assert.deepEqual(parseClaims(raw, reply).map(c => c.kind), ['invented']);
        assert.deepEqual(parseClaims(raw, reply, { aboutHim: true }).map(c => c.kind), ['about-him', 'invented']);
    });

    test('factRewriteNote：about-him 的说法写「说的是他的事，上面没有写过」，并多一句别替他说；只有前两类时没有这一句', () => {
        const note = factRewriteNote([claim('你数学不差', 'about-him', '他没提过数学')]);
        assert.match(note, /「你数学不差」说的是他的事，上面没有写过（他没提过数学）/);
        assert.match(note, /别替他说他没说过的事（他的本事、过去、性格）——想说你的感觉就说感觉，想知道就问他/);
        assert.ok(!factRewriteNote([claim('团子饼跑过来')]).includes('别替他说'));
    });

    test('checkFacts：开着时 fix 档带说明重写，日志写「替他说的」；没开时同样的审稿输出里的 about-him 不当回事，原样发', async () => {
        const run = async (aboutHim: boolean) => {
            const calls = { prompts: [] as string[], regenerate: [] as string[] };
            const logs: string[] = [];
            const result = await checkFacts('你数学不差，真去考不会差', {
                mode: 'fix', source: [{ role: 'user', content: '我在纠结要不要考研' }], names,
                audit: async messages => { calls.prompts.push(messages[0]!.content); return calls.prompts.length === 1 ? json(claim('你数学不差', 'about-him', '他没说过')) : '[]'; },
                regenerate: async note => { calls.regenerate.push(note); return '我觉得你先想清楚是不是真想读'; },
                log: line => logs.push(line), ...(aboutHim ? { aboutHim: true } : {}),
            });
            return { result, calls, logs };
        };
        const on = await run(true);
        assert.equal(on.result, '我觉得你先想清楚是不是真想读');
        assert.ok(on.calls.prompts[0]!.includes('about-him'));
        assert.match(on.calls.regenerate[0]!, /别替他说他没说过的事/);
        assert.ok(on.logs.some(line => line.includes('替他说的「')), on.logs.join('|'));
        const off = await run(false);
        assert.equal(off.result, '你数学不差，真去考不会差');
        assert.equal(off.calls.regenerate.length, 0);
        assert.ok(!off.calls.prompts[0]!.includes('about-him'));
    });
});

describe('checkFacts：按档位处理', () => {
    function setup(overrides: { audits?: string[]; rewrites?: string[]; mode?: 'log' | 'fix'; auditFails?: boolean; regenerateFails?: boolean } = {}) {
        const audits = [...(overrides.audits ?? ['[]'])];
        const rewrites = [...(overrides.rewrites ?? [])];
        const calls = { audit: 0, regenerate: [] as string[] };
        const records: FactRecord[] = [];
        const logs: string[] = [];
        const options: FactCheckOptions = {
            mode: overrides.mode ?? 'fix',
            source: [{ role: 'system', content: '测试角色是个大二女生，养了一只叫团子饼的猫。' }, { role: 'user', content: '在干嘛' }],
            names,
            audit: async () => {
                calls.audit++;
                if (overrides.auditFails) throw new Error('模型不可用');
                return audits.shift() ?? '[]';
            },
            regenerate: async note => {
                calls.regenerate.push(note);
                if (overrides.regenerateFails) throw new Error('重写失败');
                return rewrites.shift() ?? '';
            },
            log: message => logs.push(message),
            onRecord: record => records.push(record),
        };
        return { options, calls, records, logs };
    }

    test('没问题：原样返回，只审一次，不重写', async () => {
        const { options, calls, records } = setup();
        assert.equal(await checkFacts('在逛淘宝呢，你呢', options), '在逛淘宝呢，你呢');
        assert.equal(calls.audit, 1);
        assert.deepEqual(calls.regenerate, []);
        assert.equal(records[0]!.action, 'pass');
    });

    test('太短 / 只有表情包：不调用审稿', async () => {
        const { options, calls, records } = setup();
        assert.equal(await checkFacts('哈哈', options), '哈哈');
        assert.equal(await checkFacts('<sticker:0123456789ab>', options), '<sticker:0123456789ab>');
        assert.equal(calls.audit, 0);
        assert.deepEqual(records, []);
    });

    test('log 档：查到了只记日志，回复照发，不重写', async () => {
        const { options, calls, records, logs } = setup({ mode: 'log', audits: [json(claim('团子饼一见我就跑', 'invented', '事实里没有'))] });
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', options), '在逛淘宝呢\n团子饼一见我就跑');
        assert.deepEqual(calls.regenerate, []);
        assert.equal(records[0]!.action, 'logged');
        assert.deepEqual(records[0]!.claims.map(c => c.quote), ['团子饼一见我就跑']);
        assert.ok(logs.some(l => l.includes('1 条说法对不上事实') && l.includes('只记录，照发')));
        assert.ok(!logs.some(l => l.includes('团子饼一见我就跑')), '敏感调试关着：日志里只有字数，没有原话');
    });

    test('fix 档：查到 → 带说明重写 → 再查没问题：用重写的', async () => {
        const { options, calls, records } = setup({ audits: [json(claim('团子饼一见我就跑')), '[]'], rewrites: ['在逛淘宝呢\n团子饼今天没下楼'] });
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', options), '在逛淘宝呢\n团子饼今天没下楼');
        assert.equal(calls.audit, 2);
        assert.equal(calls.regenerate.length, 1);
        assert.match(calls.regenerate[0]!, /「团子饼一见我就跑」是上面事实里没有的/);
        assert.equal(records[0]!.action, 'rewritten');
        assert.equal(records[0]!.rewritten, '在逛淘宝呢\n团子饼今天没下楼');
    });

    test('fix 档：重写后还有 → 删掉那几行；只剩这一行就留着', async () => {
        const first = setup({ audits: [json(claim('团子饼一见我就跑')), json(claim('它还回头看我'))], rewrites: ['在逛淘宝呢\n它还回头看我'] });
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', first.options), '在逛淘宝呢');
        assert.equal(first.records[0]!.action, 'dropped');
        assert.deepEqual(first.records[0]!.again!.map(c => c.quote), ['它还回头看我']);

        const only = setup({ audits: [json(claim('团子饼一见我就跑')), json(claim('它还回头看我'))], rewrites: ['它还回头看我'] });
        assert.equal(await checkFacts('团子饼一见我就跑', only.options), '它还回头看我');
        assert.equal(only.records[0]!.action, 'kept');
    });

    test('mayDropAll（主动找他）：删完剩下的撑不住这一轮就整条不发，返回空串', async () => {
        const audits = () => [json(claim('作业写完了')), json(claim('作业写完了'), claim('写了三章'))];
        const rewrites = () => ['作业写完了\n写了三章\n那这事我可就记上了'];
        const on = setup({ audits: audits(), rewrites: rewrites() });
        assert.equal(await checkFacts('作业写完了\n那这事我可就记上了', { ...on.options, mayDropAll: true }), '');
        assert.equal(on.records[0]!.action, 'dropped');

        const off = setup({ audits: audits(), rewrites: rewrites() });
        assert.equal(await checkFacts('作业写完了\n那这事我可就记上了', off.options), '那这事我可就记上了', '回复里照旧删行照发');
    });

    test('审稿出错 / 重写失败：不挡回复', async () => {
        const broken = setup({ auditFails: true });
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', broken.options), '在逛淘宝呢\n团子饼一见我就跑');
        assert.equal(broken.records[0]!.action, 'skipped');
        assert.ok(broken.logs.some(l => l.includes('没查成')));

        const noRewrite = setup({ audits: [json(claim('团子饼一见我就跑'))], regenerateFails: true });
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', noRewrite.options), '在逛淘宝呢');
        assert.equal(noRewrite.records[0]!.action, 'dropped');
    });

    test('审稿超时：照发', async () => {
        const { options, records } = setup();
        const slow: FactCheckOptions = { ...options, timeoutMs: 20, audit: () => new Promise<string>(resolve => setTimeout(() => resolve('[]'), 500)) };
        assert.equal(await checkFacts('在逛淘宝呢\n团子饼一见我就跑', slow), '在逛淘宝呢\n团子饼一见我就跑');
        assert.equal(records[0]!.action, 'skipped');
    });
});

describe('模拟器里走一遍（开 / 关）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const scenarioOf = (factCheck: string | undefined, say: string) => parseScenario({
        name: '事实检查', tier: 'boyfriend', start: '2026-10-24T20:00:00+08:00', memory: false, ...(factCheck ? { factCheck } : {}),
        steps: [{ say }],
    });
    /** 假模型：审稿的请求回一条“没依据”；带“没有发出去”说明的重写回干净的；其余回编了小动作的 */
    const model = (calls: { audit: number; rewrite: number }) => async (messages: OpenAIMessage[]) => {
        if (messages[0]?.content.startsWith('你是审稿员')) {
            calls.audit++;
            const reply = messages[1]!.content.split('## 她准备发出去的回复\n')[1]!;
            return reply.includes('撒腿就跑') ? json(claim('团子饼一见我撒腿就跑')) : '[]';
        }
        if (messages.at(-1)?.content.includes('上一版回复没有发出去')) { calls.rewrite++; return '在刷手机呢，你呢'; }
        return '在刷手机呢\n团子饼一见我撒腿就跑';
    };

    for (const mode of ['fix', 'log', undefined] as const) {
        test(`factCheck ${mode ?? '关着'}`, async () => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-fact-sim-'));
            const calls = { audit: 0, rewrite: 0 };
            try {
                const result = await runScenario(scenarioOf(mode, '你在干嘛'), { runId: 'fact', dataDir: dir, card, llm, prompt, generate: model(calls) });
                const said = result.steps.flatMap(step => step.bubbles).map(b => b.text).join('\n');
                if (mode === 'fix') assert.ok(said.includes('在刷手机呢，你呢') && !said.includes('撒腿就跑'), `fix：${said}`);
                else assert.ok(said.includes('撒腿就跑'), `${mode}：${said}`);
                if (mode === undefined) {
                    assert.equal(calls.audit, 0, '关着不审稿');
                    assert.ok(result.steps.every(step => !step.facts));
                } else {
                    assert.ok(calls.audit >= 1);
                    const facts = result.steps.flatMap(step => step.facts ?? []);
                    assert.equal(facts[0]!.claims[0]!.quote, '团子饼一见我撒腿就跑');
                    assert.match(renderReport(result), /事实检查（/);
                    assert.equal(calls.rewrite, mode === 'fix' ? 1 : 0);
                }
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    }

    test('factHim 一路走通（模拟器 → contact → 审稿）：开着时审稿的提示词里有第三类、她替他说的被带说明重写；没开时审稿的提示词里没有', async () => {
        const run = async (factHim: boolean) => {
            const dir = mkdtempSync(join(tmpdir(), 'qqbot-fact-sim-'));
            const seen = { audit: [] as string[], rewrite: [] as string[] };
            try {
                const result = await runScenario(scenarioOf('fix', '我在纠结要不要考研'), {
                    runId: 'fact-him', dataDir: dir, card, llm, prompt, ...(factHim ? { factHim: true } : {}),
                    generate: async (messages: OpenAIMessage[]) => {
                        if (messages[0]?.content.startsWith('你是审稿员')) {
                            seen.audit.push(messages[0].content);
                            const reply = messages[1]!.content.split('## 她准备发出去的回复\n')[1]!;
                            return reply.includes('你数学不差') ? json(claim('你数学不差', 'about-him', '他没说过')) : '[]';
                        }
                        if (messages.at(-1)?.content.includes('上一版回复没有发出去')) { seen.rewrite.push(messages.at(-1)!.content); return '我觉得你先想清楚是不是真想读'; }
                        return '你数学不差，真去考不会差的';
                    },
                });
                return { said: result.steps.flatMap(step => step.bubbles).map(b => b.text).join('\n'), seen };
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        };
        const on = await run(true);
        assert.equal(on.said, '我觉得你先想清楚是不是真想读');
        assert.ok(on.seen.audit[0]!.includes('about-him'));
        assert.match(on.seen.rewrite[0]!, /别替他说他没说过的事/);
        const off = await run(false);
        assert.equal(off.said, '你数学不差，真去考不会差的');
        assert.ok(off.seen.audit.every(prompt => !prompt.includes('about-him')));
        assert.equal(off.seen.rewrite.length, 0);
    });

    test('危机回合不查', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-fact-sim-'));
        const calls = { audit: 0, rewrite: 0 };
        try {
            await runScenario(scenarioOf('fix', '我不想活了，真的撑不下去了'), { runId: 'fact-crisis', dataDir: dir, card, llm, prompt, generate: model(calls) });
            assert.equal(calls.audit, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('factCheck 写错报错', () => {
        assert.throws(() => scenarioOf('maybe', '在吗'), /factCheck 应为 off \/ log \/ fix 之一/);
    });
});
