import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { parseAppConfig } from '../../bot/src/config.ts';
import { Config, toAppConfigInput } from '../src/index.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const env = { QQBOT_LLM_API_KEY: 'k' };
const minimal = {
    contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
    llm: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
};

describe('插件配置（控制台表单 → config.json 的形状 → parseAppConfig）', () => {
    test('只填必填项：默认值和 config.json 留空时一样（默认值只有 config.ts 一份）', () => {
        const fromKoishi = parseAppConfig(toAppConfigInput(Config(minimal as never)), repoRoot, env);
        const fromFile = parseAppConfig({ ...minimal, characterCard: 'characters/linmengyao/st/linmengyao-{tier}.json' }, repoRoot, env);
        assert.deepEqual(fromKoishi, fromFile);
        assert.equal(fromKoishi.unlistedFriends, true);
        assert.equal(fromKoishi.schedule, true);
        assert.equal(fromKoishi.memory, undefined);
        assert.equal(fromKoishi.dataDir, resolve(repoRoot, 'runtime/bot'));
    });

    test('额外请求参数写成 JSON；长期记忆打开时才有 memory；世界书只覆盖填了的项', () => {
        const config = Config({
            ...minimal,
            unlistedFriends: false,
            llm: { ...minimal.llm, temperature: 1.3, promptPostProcessing: 'semi', extraBody: '{"thinking":{"type":"disabled"}}' },
            prompt: { maxContext: 16384, pinExamples: true, worldInfo: { depth: 4 } },
            memory: { enabled: true },
        } as never);
        const parsed = parseAppConfig(toAppConfigInput(config), repoRoot, env);
        assert.deepEqual(parsed.llm.extraBody, { thinking: { type: 'disabled' } });
        assert.equal(parsed.llm.temperature, 1.3);
        assert.equal(parsed.llm.promptPostProcessing, 'semi');
        assert.equal(parsed.prompt.worldInfo.depth, 4);
        assert.equal(parsed.prompt.worldInfo.budgetPercent, 25);
        assert.deepEqual(parsed.memory, { baseUrl: 'http://127.0.0.1:8888', timeoutMs: 30_000, recallTimeoutMs: 3000, bankPrefix: 'linmengyao' });
        assert.equal(parsed.unlistedFriends, false);
    });

    test('写错的地方报错：extraBody 不是 JSON、档位不存在、QQ 号重复', () => {
        assert.throws(() => toAppConfigInput(Config({ ...minimal, llm: { ...minimal.llm, extraBody: '{thinking' } } as never)), /llm\.extraBody/);
        assert.throws(() => Config({ ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'unlisted' }] } as never));
        const twins = { ...minimal, contacts: [{ qq: 1, name: 'a', tier: 'classmate' }, { qq: 1, name: 'b', tier: 'known' }] };
        assert.throws(() => parseAppConfig(toAppConfigInput(Config(twins as never)), repoRoot, env), /重复/);
    });
});
