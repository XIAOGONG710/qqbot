import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { chatCompletion, EXTRACT_MAX_TOKENS, forExtraction, ModelUnreachable, RETRY_DELAYS_MS, type LlmOptions } from '../src/language/llm.ts';

const options: LlmOptions = {
    baseUrl: 'https://llm.example/',
    model: 'm',
    apiKey: 'k',
    temperature: 1.3,
    maxTokens: 300,
    timeoutMs: 5000,
    extraBody: {},
};
const messages = [{ role: 'user' as const, content: '在吗' }];
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '在呢' }, finish_reason: 'stop' }] }));
/** undici 连不上时 fetch 抛出的错误形状 */
const networkError = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(`${code} detail`), { code }) });

function fakeFetch(results: (() => Response | Error)[]) {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
        calls.push(String(url));
        const result = results[calls.length - 1]!();
        if (result instanceof Error) throw result;
        return result;
    }) as typeof globalThis.fetch;
    return { fetch, calls };
}

describe('模型请求', () => {
    test('extraBody 合并进请求体，同名字段以它为准', async () => {
        let received: Record<string, unknown> = {};
        let auth = '';
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                received = JSON.parse(body);
                auth = req.headers.authorization ?? '';
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message: { content: '在呢' }, finish_reason: 'stop' }] }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const { port } = server.address() as AddressInfo;
            const reply = await chatCompletion({
                ...options,
                baseUrl: `http://127.0.0.1:${port}/`,
                extraBody: { thinking: { type: 'disabled' }, max_tokens: 100 },
            }, messages);
            assert.equal(reply, '在呢');
            assert.equal(auth, 'Bearer k');
            assert.deepEqual(received, {
                model: 'm',
                messages,
                temperature: 1.3,
                max_tokens: 100,
                stream: false,
                thinking: { type: 'disabled' },
            });
        } finally {
            server.close();
        }
    });

    test('连接失败时按间隔重试，连上就返回', async () => {
        const failures = RETRY_DELAYS_MS.map((_, i) => () => networkError(i % 2 ? 'ECONNRESET' : 'UND_ERR_CONNECT_TIMEOUT'));
        const { fetch, calls } = fakeFetch([...failures, ok]);
        const slept: number[] = [];
        const logs: string[] = [];
        const reply = await chatCompletion(options, messages, { fetch, sleep: async ms => { slept.push(ms); }, log: m => logs.push(m) });
        assert.equal(reply, '在呢');
        assert.deepEqual(calls, Array(RETRY_DELAYS_MS.length + 1).fill('https://llm.example/chat/completions'));
        assert.deepEqual(slept, RETRY_DELAYS_MS);
        assert.ok(logs[0]!.includes('UND_ERR_CONNECT_TIMEOUT'));
    });

    test('思考用完 max_tokens、正文是空的：照样返回空文本，日志写明是被截断', async () => {
        const truncated = () => new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '想……' }, finish_reason: 'length' }] }));
        const logs: string[] = [];
        assert.equal(await chatCompletion(options, messages, { fetch: fakeFetch([truncated]).fetch, log: m => logs.push(m) }), '');
        assert.deepEqual(logs, ['模型输出被截断：思考用完了 max_tokens，正文是空的，思考 3 字']);
        // 没到上限也空（10-11 接梗模拟：思考里把回复写完了，正文什么都没有）：写明 finish 和思考多长
        const stopped = () => new Response(JSON.stringify({ choices: [{ message: { content: ' ', reasoning_content: '他说山楂树' }, finish_reason: 'stop' }] }));
        const empty: string[] = [];
        assert.equal(await chatCompletion(options, messages, { fetch: fakeFetch([stopped]).fetch, log: m => empty.push(m) }), ' ');
        assert.deepEqual(empty, ['模型正文是空的（finish=stop，思考 5 字）']);
        const quiet: string[] = [];
        await chatCompletion(options, messages, { fetch: fakeFetch([ok]).fetch, log: m => quiet.push(m) });
        assert.deepEqual(quiet, []);
    });

    test('后台抽取用的配置：同一个模型，输出上限放大到 8192（配得更大的不改）', () => {
        assert.deepEqual(forExtraction(options), { ...options, maxTokens: EXTRACT_MAX_TOKENS });
        assert.equal(EXTRACT_MAX_TOKENS, 8192);
        assert.equal(forExtraction({ ...options, maxTokens: 16384 }).maxTokens, 16384);
    });

    test('重试用完后报错，错误里带上具体原因', async () => {
        const { fetch, calls } = fakeFetch(Array(RETRY_DELAYS_MS.length + 1).fill(() => networkError('UND_ERR_CONNECT_TIMEOUT')));
        await assert.rejects(
            chatCompletion(options, messages, { fetch, sleep: async () => {} }),
            /模型接口请求失败（UND_ERR_CONNECT_TIMEOUT：UND_ERR_CONNECT_TIMEOUT detail）/,
        );
        assert.equal(calls.length, RETRY_DELAYS_MS.length + 1);
    });

    test('HTTP 错误、整体超时和其他错误不重试', async () => {
        const http = fakeFetch([() => new Response('{"error":"bad key"}', { status: 401 })]);
        await assert.rejects(chatCompletion(options, messages, { fetch: http.fetch, sleep: async () => {} }), /返回 401/);
        assert.equal(http.calls.length, 1);

        const timeout = fakeFetch([() => new DOMException('The operation was aborted due to timeout', 'TimeoutError')]);
        await assert.rejects(chatCompletion(options, messages, { fetch: timeout.fetch, sleep: async () => {} }), /TimeoutError/);
        assert.equal(timeout.calls.length, 1);

        const other = fakeFetch([() => networkError('UND_ERR_HEADERS_TIMEOUT')]);
        await assert.rejects(chatCompletion(options, messages, { fetch: other.fetch, sleep: async () => {} }), /UND_ERR_HEADERS_TIMEOUT/);
        assert.equal(other.calls.length, 1);
    });

    test('没连上模型（网络、DNS、超时、429、5xx）和别的错误分开：后台抽取遇到前一种不算失败次数', async () => {
        const unreachable = async (result: () => Response | Error, retries = 0) => {
            const { fetch } = fakeFetch(Array(retries + 1).fill(result));
            return chatCompletion(options, messages, { fetch, sleep: async () => {} }).then(() => undefined, (error: unknown) => error instanceof ModelUnreachable);
        };
        assert.equal(await unreachable(() => networkError('ENOTFOUND'), RETRY_DELAYS_MS.length), true);
        assert.equal(await unreachable(() => networkError('UND_ERR_HEADERS_TIMEOUT')), true);
        assert.equal(await unreachable(() => new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
        assert.equal(await unreachable(() => new Response('busy', { status: 503 })), true);
        assert.equal(await unreachable(() => new Response('slow down', { status: 429 })), true);
        assert.equal(await unreachable(() => new Response('{"error":"bad key"}', { status: 401 })), false);
        assert.equal(await unreachable(() => new Response('{}')), false, '回了但没有文本');
    });
});

test('请求体里落单的半个表情换成 U+FFFD，完整的表情和平常的字原样（按 UTF-16 截短截在表情中间时，有的接口转 UTF-8 会整条报错）', async () => {
    const half = '小王😀'.slice(0, 3); // 截在表情中间：留下高位代理
    assert.equal(half.isWellFormed(), false);
    let body = '';
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => { body = String(init?.body); return ok(); }) as typeof globalThis.fetch;
    await chatCompletion(options, [{ role: 'user', content: `转发：${half}：在吗 / 阿明😀：好` }], { fetch });
    assert.doesNotMatch(body, /\ud83d(?!\ude00)/i, '没有落单的高位代理转义');
    const sent = JSON.parse(body) as { messages: { content: string }[] };
    assert.equal(sent.messages[0]!.content, '转发：小王�：在吗 / 阿明😀：好');
    assert.ok(sent.messages[0]!.content.isWellFormed());
});
