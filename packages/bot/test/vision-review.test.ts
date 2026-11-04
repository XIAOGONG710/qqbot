import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepSeekImageDescriber, type VisionFetch } from '../src/vision/vision.ts';
import { ModelGuard } from '../src/language/model-guard.ts';
import { ModelUnreachable } from '../src/language/llm.ts';

const png = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')}`;
const options = { baseUrl: 'https://synthetic.invalid', model: 'synthetic', apiKey: 'synthetic', timeoutMs: 15 };
const ok: VisionFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '合成描述' } }] }) });
const hang = <T>() => new Promise<T>(() => {});
async function outcome(task: Promise<string>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([task.then(value => value, error => error), new Promise<string>(resolve => { timer = setTimeout(() => resolve('HUNG'), 100); })]);
    clearTimeout(timer!); return result;
}

test('下载不响应取消仍有独立截止，失败不占模型额度', async () => {
    const guard = new ModelGuard();
    const result = await outcome(deepSeekImageDescriber(options, ok, () => hang<string>(), guard).describe({ url: 'https://synthetic.invalid/a' }));
    assert.ok(result instanceof ModelUnreachable);
    assert.equal(guard.status().callsToday, 0);
});

test('请求或正文不响应取消也释放模型预算槽，后来请求可恢复', async () => {
    for (const phase of ['fetch', 'body']) {
        const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1, breakerFailures: 10 });
        const fetch: VisionFetch = phase === 'fetch' ? () => hang() : async () => ({ ok: true, status: 200, text: () => hang<string>() });
        const result = await outcome(deepSeekImageDescriber(options, fetch, undefined, guard).describe({ url: png }));
        assert.ok(result instanceof ModelUnreachable);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(guard.status().active, 0);
        assert.equal(await deepSeekImageDescriber({ ...options, timeoutMs: 100 }, ok, undefined, guard).describe({ url: png }), '合成描述');
    }
});

test('取消后不下载、不发模型请求', async () => {
    const controller = new AbortController(); controller.abort(new Error('stop'));
    let downloads = 0; let calls = 0;
    const vision = deepSeekImageDescriber(options, async (...args) => { calls++; return ok(...args); }, async () => { downloads++; return png; });
    await assert.rejects(vision.describe({ url: 'https://synthetic.invalid/a', signal: controller.signal }));
    assert.equal(downloads, 0); assert.equal(calls, 0);
});

test('迟到的下载不再启动模型，迟到响应只清理且不读取正文', async () => {
 let releaseDownload!: (value: string) => void; let calls = 0;
 const pending = deepSeekImageDescriber(options, async (...args) => { calls++; return ok(...args); }, () => new Promise(resolve => { releaseDownload = resolve; })).describe({ url: 'https://synthetic.invalid/a' });
 assert.ok(await outcome(pending) instanceof ModelUnreachable);
 releaseDownload(png); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0);
 let releaseFetch!: (value: Awaited<ReturnType<VisionFetch>>) => void; let cancelled = 0; let read = 0;
 const late = deepSeekImageDescriber(options, () => new Promise(resolve => { releaseFetch = resolve; })).describe({ url: png });
 assert.ok(await outcome(late) instanceof ModelUnreachable);
 releaseFetch({ ok: true, status: 200, body: new ReadableStream({ cancel() { cancelled++; } }), text: async () => { read++; return 'PRIVATE'; } });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1); assert.equal(read, 0);
});

test('超时包括视觉并发队列和ModelGuard队列，取消队列后无幽灵请求', async () => {
 const releases: (() => void)[] = [];
 const started: VisionFetch = async () => new Promise(resolve => { releases.push(() => resolve({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"合成描述"}}]}' })); });
 const first = deepSeekImageDescriber({ ...options, timeoutMs: 500 }, started).describe({ url: png });
 const second = deepSeekImageDescriber({ ...options, timeoutMs: 500 }, started).describe({ url: png });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(releases.length, 2);
 let queuedCalls = 0;
 assert.ok(await outcome(deepSeekImageDescriber(options, async (...args) => { queuedCalls++; return ok(...args); }).describe({ url: png })) instanceof ModelUnreachable);
 assert.equal(queuedCalls, 0);
 for (const release of releases) release(); await Promise.all([first, second]);
 const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1 }); let release!: () => void;
 const hold = guard.run('chat', () => new Promise<void>(resolve => { release = resolve; }));
 assert.ok(await outcome(deepSeekImageDescriber(options, async (...args) => { queuedCalls++; return ok(...args); }, undefined, guard).describe({ url: png })) instanceof ModelUnreachable);
 assert.equal(guard.status().waiting, 0); assert.equal(queuedCalls, 0);
 release(); await hold;
 assert.equal(await deepSeekImageDescriber({ ...options, timeoutMs: 100 }, ok, undefined, guard).describe({ url: png }), '合成描述');
});

test('调用者取消保留原reason并释放已开始的guard，超时参与熔断且可恢复', async () => {
 const guard = new ModelGuard({ concurrent: 1, breakerFailures: 1 });
 const controller = new AbortController(); const reason = { synthetic: 'caller' };
 const task = deepSeekImageDescriber({ ...options, timeoutMs: 500 }, () => hang(), undefined, guard).describe({ url: png, signal: controller.signal });
 await new Promise(resolve => setImmediate(resolve)); controller.abort(reason);
 assert.equal(await outcome(task), reason);
 await new Promise(resolve => setImmediate(resolve)); assert.equal(guard.status().active, 0); assert.equal(guard.status().breakerOpen, false);
 let now = Date.now();
 const breaker = new ModelGuard({ concurrent: 1, breakerFailures: 1, breakerOpenMs: 10, now: () => now });
 assert.ok(await outcome(deepSeekImageDescriber({ ...options, purpose: 'background' }, () => hang(), undefined, breaker).describe({ url: png })) instanceof ModelUnreachable);
 await new Promise(resolve => setImmediate(resolve)); assert.equal(breaker.status().active, 0); assert.equal(breaker.status().breakerOpen, true);
 now += 11;
 assert.equal(await deepSeekImageDescriber({ ...options, timeoutMs: 100, purpose: 'background' }, ok, undefined, breaker).describe({ url: png }), '合成描述');
});

test('HTTP错误不读取永久等待的正文，状态码保留而流被取消', async () => {
 let read = 0; let cancelled = 0; let calls = 0;
 const fetch: VisionFetch = async () => { calls++; return { ok: false, status: 400, body: new ReadableStream({ cancel() { cancelled++; } }), text: () => { read++; return hang<string>(); } }; };
 const result = await outcome(deepSeekImageDescriber(options, fetch).describe({ url: png }));
 assert.ok(result instanceof Error); assert.match(result.message, /返回 400/);
 assert.equal(read, 0); assert.equal(cancelled, 1); assert.equal(calls, 1);
});

test('成功模型回复限制正文大小并取消流，text-only替身也受后验字节校验', async () => {
 let cancelled = 0; let supplied = 0;
 const fetch: VisionFetch = async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ pull(controller) { supplied += 64 * 1024; controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled++; } }), text: async () => assert.fail('有body时不走text') });
 await assert.rejects(deepSeekImageDescriber({ ...options, timeoutMs: 100 }, fetch).describe({ url: png }), /过大/);
 assert.equal(cancelled, 1); assert.ok(supplied <= 1024 * 1024 + 2 * 64 * 1024);
 const text: VisionFetch = async () => ({ ok: true, status: 200, text: async () => 'PRIVATE'.repeat(200_000) });
 await assert.rejects(deepSeekImageDescriber({ ...options, timeoutMs: 100 }, text).describe({ url: png }), error => error instanceof Error && /过大/.test(error.message) && !error.message.includes('PRIVATE'));
});

test('畸形模型schema不得变成事实，空描述仍只重试一次', async () => {
 for (const content of [{ choices: { 0: { message: { content: '伪造事实' } } } }, { choices: [{ message: { content: ['伪造事实'] } }] }, null]) {
  let calls = 0;
  const fetch: VisionFetch = async () => { calls++; return { ok: true, status: 200, text: async () => JSON.stringify(content) }; };
  await assert.rejects(deepSeekImageDescriber({ ...options, timeoutMs: 100 }, fetch).describe({ url: png }), /没有文本/);
  assert.equal(calls, 2);
 }
});

test('下载与请求、空描述重试共同消耗同一个生命周期截止时间', async () => {
 const delay = <T>(value: T, ms: number) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
 const reply = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
 const fetch: VisionFetch = async () => ({ ok: true, status: 200, text: () => delay(reply('合成描述'), 15) });
 assert.ok(await outcome(deepSeekImageDescriber({ ...options, timeoutMs: 20 }, fetch, () => delay(png, 10)).describe({ url: 'https://synthetic.invalid/a' })) instanceof ModelUnreachable);
 let calls = 0;
 const retry: VisionFetch = async () => { const attempt = ++calls; return { ok: true, status: 200, text: () => delay(reply(attempt === 1 ? '' : '合成描述'), 12) }; };
 assert.ok(await outcome(deepSeekImageDescriber({ ...options, timeoutMs: 20 }, retry).describe({ url: png })) instanceof ModelUnreachable);
 assert.ok(calls <= 2);
});

test('成功响应流不出数据且cancel永久等待时仍释放guard和视觉闸门', async () => {
 let cancelled = 0;
 const guard = new ModelGuard({ concurrent: 1, breakerFailures: 10 });
 const fetch: VisionFetch = async () => ({ ok: true, status: 200, body: new ReadableStream<Uint8Array>({ cancel() { cancelled++; return hang<void>(); } }), text: async () => assert.fail('不能读text') });
 assert.ok(await outcome(deepSeekImageDescriber(options, fetch, undefined, guard).describe({ url: png })) instanceof ModelUnreachable);
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(cancelled, 1); assert.equal(guard.status().active, 0);
 assert.equal(await deepSeekImageDescriber({ ...options, timeoutMs: 100 }, ok, undefined, guard).describe({ url: png }), '合成描述');
});
