import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCompletion, type LlmOptions, type LlmDeps } from '../src/language/llm.ts';
import type { ModelGuard } from '../src/language/model-guard.ts';
const guard = { run: async (_purpose: unknown, work: () => Promise<string>) => work() } as unknown as ModelGuard;
const options: LlmOptions = { baseUrl: 'http://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic', temperature: 0, maxTokens: 30, timeoutMs: 5000, extraBody: {} };
const tick = () => new Promise<void>(done => setImmediate(done));
for (const phase of ['fetch', 'body', 'retry-sleep'] as const) test(`收藏判断共用LLM ${phase}取消后不交付旧正文或续派重试`, async () => {
    const controller = new AbortController(), logs: string[] = []; let entered = false, release!: () => void, calls = 0;
    const held = new Promise<void>(done => { release = done; });
    const deps = { guard, signal: controller.signal, log: (line: string) => logs.push(line),
        sleep: async () => { entered = true; await held; },
        fetch: async () => {
            calls++; if (phase === 'fetch') { entered = true; await held; }
            if (phase === 'retry-sleep' && calls === 1) throw new TypeError('synthetic connection', { cause: { code: 'ECONNRESET' } });
            return { ok: true, status: 200, text: async () => { if (phase === 'body') { entered = true; await held; } return JSON.stringify({ choices: [{ message: { content: '合成判断' } }] }); } };
        },
    } as Partial<LlmDeps> & { signal: AbortSignal };
    const result = chatCompletion(options, [], deps).then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 30 && !entered; i++) await tick(); assert.ok(entered);
    const before = [...logs]; controller.abort(); release(); const settled = await result;
    assert.ok('error' in settled); assert.equal(calls, 1); assert.deepEqual(logs, before);
});
test('收藏判断共用LLM已取消任务不进入provider', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    await assert.rejects(chatCompletion(options, [], { guard, signal: controller.signal, fetch: async () => { calls++; return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"合成"}}]}' }; } } as Partial<LlmDeps> & { signal: AbortSignal }));
    assert.equal(calls, 0);
});

test('默认重试等待可取消，不占住调用等待完整退避间隔', async () => {
    const controller = new AbortController(); let retrying = false, calls = 0;
    const task = chatCompletion(options, [], { guard, signal: controller.signal, log: () => { retrying = true; },
        fetch: async () => { calls++; throw new TypeError('synthetic connection', { cause: { code: 'ECONNRESET' } }); },
    }).then(() => 'success', () => 'cancelled');
    for (let i = 0; i < 30 && !retrying; i++) await tick(); assert.ok(retrying);
    controller.abort(); let timer: ReturnType<typeof setTimeout> | undefined;
    try { assert.equal(await Promise.race([task, new Promise<string>(done => { timer = setTimeout(() => done('still waiting'), 500); })]), 'cancelled'); assert.equal(calls, 1); }
    finally { clearTimeout(timer); await task; }
});
