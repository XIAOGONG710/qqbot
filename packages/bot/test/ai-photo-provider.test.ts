import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { aiPhotoProvidersFromEnv, createAiPhotoProviderPool, type AiPhotoProvider } from '../src/vision/ai-photo-provider.ts';

const providers: AiPhotoProvider[] = [
    { id: 'primary', baseUrl: 'https://primary.test/v1', apiKey: 'primary-secret', model: 'primary-model', timeoutMs: 1000, local: false },
    { id: 'local', baseUrl: 'http://127.0.0.1:8188/v1', apiKey: 'local-secret', model: 'local-model', timeoutMs: 1000, local: true },
    { id: 'fallback', baseUrl: 'https://fallback.test/v1', apiKey: 'fallback-secret', model: 'fallback-model', timeoutMs: 1000, local: false },
];

describe('AI 照片供应商与预算（ADR 0244）', () => {
    test('环境变量按本地、主服务、备用服务解析，缺密钥的不启用', () => {
        const result = aiPhotoProvidersFromEnv({
            QQBOT_IMAGE_LOCAL_BASE_URL: 'http://127.0.0.1:8188/v1', QQBOT_IMAGE_LOCAL_MODEL: 'local',
            QQBOT_IMAGE_API_KEY: 'primary-secret', QQBOT_IMAGE_BASE_URL: 'https://primary.test/v1',
            QQBOT_IMAGE_FALLBACK_API_KEY: 'fallback-secret', QQBOT_IMAGE_FALLBACK_BASE_URL: 'https://fallback.test/v1',
            QQBOT_IMAGE_TIMEOUT_MS: '5000',
        });
        assert.deepEqual(result.map(item => [item.id, item.model, item.timeoutMs]), [['local', 'local', 5000], ['primary', 'gpt-image-2.5-flare', 5000], ['fallback', 'gpt-image-2.5-flare', 5000]]);
        assert.deepEqual(aiPhotoProvidersFromEnv({ QQBOT_IMAGE_BASE_URL: 'https://unused.test/v1' }), []);
        assert.deepEqual(aiPhotoProvidersFromEnv({
            QQBOT_IMAGE_LOCAL_BASE_URL: 'https://public.example/v1',
            QQBOT_IMAGE_API_KEY: 'secret', QQBOT_IMAGE_BASE_URL: 'http://insecure.example/v1',
            QQBOT_IMAGE_FALLBACK_API_KEY: 'fallback', QQBOT_IMAGE_FALLBACK_BASE_URL: 'https://user:pass@fallback.test/v1',
        }), []);
    });

    test('本地优先；失败后切主服务，不把错误或提示词写入用量文件', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-provider-'));
        const calls: string[] = [];
        const pool = createAiPhotoProviderPool({
            dir, providers, dailyLimit: 5, now: () => new Date(2026, 10, 4, 12, 0),
            generate: async (prompt, options) => {
                calls.push(options.model);
                assert.equal(prompt, 'PRIVATE PROMPT');
                if (options.model === 'local-model') throw new Error('PRIVATE ERROR primary-secret');
                return { bytes: new Uint8Array([0xff, 0xd8, 0xff]), model: options.model };
            },
        });
        assert.equal((await pool.generate('PRIVATE PROMPT')).model, 'primary-model');
        assert.deepEqual(calls, ['local-model', 'primary-model']);
        assert.deepEqual(pool.status(), { day: '2026-11-04', attempts: 2, generated: 1, failed: 1, remaining: 3, providers: ['local', 'primary', 'fallback'] });
        const saved = readFileSync(join(dir, 'usage.json'), 'utf8');
        assert.doesNotMatch(saved, /PRIVATE|secret|https?:/i);
    });

    test('每日上限按尝试次数计算，跨日恢复并保留统计', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-budget-'));
        let clock = new Date(2026, 10, 4, 23, 59);
        const pool = createAiPhotoProviderPool({
            dir, providers: [providers[1]!], dailyLimit: 2, now: () => clock,
            generate: async (_prompt, options) => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), model: options.model }),
        });
        await pool.generate('one');
        await pool.generate('two');
        await assert.rejects(pool.generate('three'), /达到上限/);
        clock = new Date(2026, 10, 5, 0, 1);
        assert.equal(pool.status().remaining, 2);
        await pool.generate('next-day');
        assert.equal(pool.status().generated, 1);
    });

    test('供应商全失败时给统一错误，不泄露上游原文', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'ai-photo-failover-'));
        const pool = createAiPhotoProviderPool({
            dir, providers: providers.slice(0, 2), dailyLimit: 4,
            generate: async () => { throw new Error('Authorization primary-secret PRIVATE PROMPT'); },
        });
        await assert.rejects(pool.generate('PRIVATE PROMPT'), error => error instanceof Error && error.message === 'AI 生图服务暂时不可用，或今天的调用额度已经用完');
        assert.equal(pool.status().failed, 2);
    });
});

