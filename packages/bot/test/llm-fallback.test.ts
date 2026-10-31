import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCompletion } from '../src/language/llm.ts';

const base = { baseUrl: 'https://free.example', model: 'm', apiKey: 'k', temperature: 0, maxTokens: 8, timeoutMs: 1000, extraBody: {} };

// 2026-10-31：免费网关 12:00-14:00 关着，那两小时要自动退回官方线路
test('主线路 403（免费组关窗）时退回备用线路', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://free.example')) return { ok: false, status: 403, text: async () => '{"error":"closed"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '官方回了' } }] }) };
    };
    const text = await chatCompletion({ ...base, fallback: { baseUrl: 'https://official.example', apiKey: 'official' } }, [{ role: 'user', content: 'hi' }], { fetch: fakeFetch as never, log: () => undefined, sleep: async () => undefined, guard: { run: async (_p: string, fn: () => Promise<string>) => fn() } as never });
    assert.equal(text, '官方回了');
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.startsWith('https://official.example'));
});

test('没有备用线路就照旧报错', async () => {
    const fakeFetch = async () => ({ ok: false, status: 403, text: async () => '{}' });
    await assert.rejects(() => chatCompletion(base, [{ role: 'user', content: 'hi' }], { fetch: fakeFetch as never, log: () => undefined, sleep: async () => undefined, guard: { run: async (_p: string, fn: () => Promise<string>) => fn() } as never }));
});
