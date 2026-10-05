import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { DEFAULTS, parseAppConfig } from '../../bot/src/config.ts';
import { Config, migrateThinking, thinkingBody, toAppConfigInput } from '../src/index.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const env = { QQBOT_LLM_API_KEY: 'k' };
const minimal = {
    contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
    llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
};
const fromKoishi = (config: object) => parseAppConfig(toAppConfigInput(Config(config as never)), repoRoot, env);

/** ADR 0009 之前控制台存下的写法（形状同 koishi.example.yml 的旧版，联系人是虚构的） */
const before0009 = {
    contacts: [
        { qq: 10001, name: '阿明', tier: 'boyfriend' },
        { qq: 10002, name: '同学甲', tier: 'classmate', persona: '网上认识的学长，比较熟' },
    ],
    unlistedFriends: false,
    llm: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        temperature: 1.3,
        maxTokens: 4096,
        promptPostProcessing: 'semi',
        extraBody: '{"thinking":{"type":"disabled"}}',
    },
    prompt: { maxContext: 16384, pinExamples: true },
    memory: { enabled: true },
};
/** 同一份配置在 runtime/bot/config.json 里的写法 */
const before0009AsJson = {
    ...before0009,
    llm: { ...before0009.llm, extraBody: { thinking: { type: 'disabled' } } },
    memory: { baseUrl: 'http://127.0.0.1:8888' },
    characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json',
};

describe('插件配置（控制台表单 → config.json 的形状 → parseAppConfig）', () => {
    test('只填必填项：默认值和 config.json 留空时一样（默认值只有 config.ts 一份）', () => {
        const fromFile = parseAppConfig({ ...minimal, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' }, repoRoot, env);
        assert.deepEqual(fromKoishi(minimal), fromFile);
        assert.equal(fromFile.unlistedFriends, true);
        assert.equal(fromFile.memory, undefined);
        assert.equal(fromFile.dataDir, resolve(repoRoot, 'runtime/bot'));
    });

    test('表单里显示的默认值就是 config.ts 的 DEFAULTS', () => {
        const config = Config({ ...minimal, memory: { enabled: true } } as never);
        assert.equal(config.llm.temperature, DEFAULTS.llm.temperature);
        assert.equal(config.llm.maxTokens, DEFAULTS.llm.maxTokens);
        assert.equal(config.llm.timeoutMs, DEFAULTS.llm.timeoutMs);
        assert.equal(config.llm.promptPostProcessing, DEFAULTS.llm.promptPostProcessing);
        assert.equal(config.llm.thinking, undefined);
        assert.equal(config.prompt.maxContext, DEFAULTS.prompt.maxContext);
        assert.equal(config.prompt.pinExamples, DEFAULTS.prompt.pinExamples);
        assert.deepEqual(config.prompt.worldInfo, DEFAULTS.prompt.worldInfo);
        assert.equal(config.unlistedFriends, DEFAULTS.unlistedFriends);
        assert.equal(config.schedule, DEFAULTS.schedule);
        assert.equal(config.proactive, DEFAULTS.proactive);
        assert.equal(config.dataDir, DEFAULTS.dataDir);
        assert.equal(config.memory.timeoutMs, DEFAULTS.memory.timeoutMs);
        assert.equal(config.memory.recallTimeoutMs, DEFAULTS.memory.recallTimeoutMs);
        assert.equal(config.memory.bankPrefix, DEFAULTS.memory.bankPrefix);
    });

    test('ADR 0009 之前存下的写法照常能读，解析结果和 config.json 一样', () => {
        assert.deepEqual(fromKoishi(before0009), parseAppConfig(before0009AsJson, repoRoot, env));
    });

    test('写回 koishi.yml（schema.simplify，loader 和控制台的「按 JSON 编辑」都用它）再读出来，配置不变', () => {
        const samples = [
            minimal,
            before0009,
            { ...before0009, llm: { ...before0009.llm, thinking: 'high', extraBody: '{"top_p":0.9}', timeoutMs: 60_000 } },
            { ...minimal, memory: { enabled: true, baseUrl: 'http://127.0.0.1:9999', recallTimeoutMs: 5000 }, prompt: { worldInfo: { depth: 4, caseSensitive: true } } },
            { ...minimal, memory: { enabled: false }, schedule: false, dataDir: 'runtime/bot-test' },
            { ...minimal, proactive: 'dryRun' },
        ];
        for (const sample of samples) {
            const config = Config(sample as never);
            assert.deepEqual(Config(Config.simplify(config) as never), config, JSON.stringify(sample));
        }
    });

    test('主动消息（ADR 0011）：旧的配置没有这一项时是关；试运行、开照样传过去；写错报错', () => {
        assert.equal(fromKoishi(minimal).proactive, 'off');
        assert.equal(fromKoishi(before0009).proactive, 'off');
        assert.equal(fromKoishi({ ...minimal, proactive: 'dryRun' }).proactive, 'dryRun');
        assert.equal(fromKoishi({ ...minimal, proactive: 'on' }).proactive, 'on');
        assert.throws(() => Config({ ...minimal, proactive: 'yes' } as never));
        // 等于默认值时不写进 koishi.yml
        assert.equal('proactive' in (Config.simplify(Config(minimal as never)) as object), false);
    });

    test('长期记忆打开时才有 memory；世界书只覆盖填了的项', () => {
        const parsed = fromKoishi({ ...minimal, prompt: { worldInfo: { depth: 4 } }, memory: { enabled: true } });
        assert.deepEqual(parsed.memory, { baseUrl: 'http://127.0.0.1:8888', timeoutMs: 30_000, recallTimeoutMs: 3000, bankPrefix: 'linmengyao' });
        assert.equal(parsed.prompt.worldInfo.depth, 4);
        assert.equal(parsed.prompt.worldInfo.budgetPercent, 25);
        assert.equal(fromKoishi({ ...minimal, memory: { enabled: false, baseUrl: 'http://x' } }).memory, undefined);
    });

    test('写错的地方报错：extraBody 不是 JSON 对象、档位不存在、QQ 号重复、必填项是空白', () => {
        assert.throws(() => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, extraBody: '{thinking' } } as never)), /llm\.extraBody/);
        assert.throws(() => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, extraBody: '[]' } } as never)), /JSON 对象/);
        assert.throws(() => Config({ ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'unlisted' }] } as never));
        assert.throws(() => fromKoishi({ ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'classmate' }, { qq: 1, name: 'b', tier: 'known' }] }), /重复/);
        assert.throws(() => Config({ ...minimal, llm: { ...minimal.llm, model: ' ' } } as never));
    });
});

describe('思考控件（ADR 0009 A4）', () => {
    test('关 / 低 / 高 / 最高 对应 DeepSeek 的 thinking 和 reasoning_effort；不选就都不传', () => {
        assert.deepEqual(thinkingBody('off'), { thinking: { type: 'disabled' } });
        assert.deepEqual(thinkingBody('max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
        const withThinking = (thinking: string | undefined, extraBody = '{"top_p":0.9}') =>
            fromKoishi({ ...minimal, llm: { ...minimal.llm, thinking, extraBody } }).llm.extraBody;
        assert.deepEqual(withThinking('low'), { top_p: 0.9, thinking: { type: 'enabled' }, reasoning_effort: 'low' });
        assert.deepEqual(withThinking(undefined), { top_p: 0.9 });
    });

    test('控件选了值，其他参数里又写了 thinking / reasoning_effort：报错', () => {
        const both = (extraBody: string) => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, thinking: 'off', extraBody } } as never));
        assert.throws(() => both('{"thinking":{"type":"disabled"}}'), /只|不要再写/);
        assert.throws(() => both('{"reasoning_effort":"low"}'), /不要再写/);
    });

    test('旧写法迁移到控件：请求体不变，写回 koishi.yml 时不留空的其他参数', () => {
        const old = Config(before0009 as never);
        const migrated = migrateThinking(old)!;
        assert.equal(migrated.llm.thinking, 'off');
        assert.equal(migrated.llm.extraBody, '{}');
        assert.deepEqual(parseAppConfig(toAppConfigInput(migrated), repoRoot, env), parseAppConfig(toAppConfigInput(old), repoRoot, env));
        // loader 写回时按 Schema 去掉等于默认值的项（schema.simplify）
        const written = Config.simplify(migrated) as { llm: Record<string, unknown> };
        assert.equal(written.llm.thinking, 'off');
        assert.equal('extraBody' in written.llm, false);
        assert.equal(migrateThinking(Config(written as never)), undefined, '迁移一次就够');
    });

    test('只迁移能一一对上的写法，其余原样留在 JSON 里', () => {
        const migrate = (extraBody: string, thinking?: string) => migrateThinking(Config({ ...minimal, llm: { ...minimal.llm, extraBody, thinking } } as never));
        const high = migrate('{"thinking":{"type":"enabled"},"reasoning_effort":"high","top_p":0.9}')!;
        assert.equal(high.llm.thinking, 'high');
        assert.deepEqual(JSON.parse(high.llm.extraBody), { top_p: 0.9 });
        assert.equal(migrate('{"thinking":{"type":"enabled"}}'), undefined, '没写强度：迁过去会多传 reasoning_effort');
        assert.equal(migrate('{"reasoning_effort":"low"}'), undefined);
        assert.equal(migrate('{"thinking":{"type":"disabled","budget":1}}'), undefined);
        assert.equal(migrate('{"thinking":{"type":"disabled"}}', 'low'), undefined, '控件已经选了');
        assert.equal(migrate('{bad'), undefined);
    });
});

test('实例模板 koishi.example.yml 里的 qqbot 一节能读，不需要迁移', () => {
    const yaml = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
    const example = yaml.load(readFileSync(resolve(repoRoot, 'packages/koishi-app/koishi.example.yml'), 'utf8')) as { plugins: { qqbot: object } };
    const config = Config(example.plugins.qqbot as never);
    assert.equal(migrateThinking(config), undefined);
    assert.equal(fromKoishi(example.plugins.qqbot).contacts.length, 1);
});
