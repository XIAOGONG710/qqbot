import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createCompanionHttpHandler, sessionFor } from '../src/http.ts';
import type { CompanionEnvelope } from '../src/protocol.ts';
import type { CompanionRuntime, CompanionRuntimeResult } from '../src/runtime.ts';

/** 纯内存的请求/响应替身：只驱动适配器自己的事件处理，不监听端口、不连网络。 */
class FakeRequest extends EventEmitter {
    headers: Record<string, string | string[] | undefined>;
    url: string;
    method: string;
    resumed = false;

    constructor(options: { headers?: Record<string, string | string[] | undefined>; url?: string; method?: string }) {
        super();
        this.headers = options.headers ?? {};
        this.url = options.url ?? '/companion/v1/envelope';
        this.method = options.method ?? 'POST';
    }

    resume(): void { this.resumed = true; }
}

class FakeResponse extends EventEmitter {
    statusCode = 200;
    headersSent = false;
    headers: Record<string, string> = {};
    body: string | undefined;
    ended = false;

    setHeader(name: string, value: string | string[]): void {
        this.headers[name.toLowerCase()] = String(value);
    }

    end(chunk?: string): void {
        this.body = chunk;
        this.ended = true;
        this.emit('finish');
    }
}

type Handler = ReturnType<typeof createCompanionHttpHandler>;

async function post(handler: Handler, options: {
    url?: string; method?: string; headers?: Record<string, string | string[] | undefined>; body?: string;
}) {
    const request = new FakeRequest(options);
    const response = new FakeResponse();
    const finished = new Promise<FakeResponse>(resolve => response.once('finish', () => resolve(response)));
    handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    request.emit('data', Buffer.from(options.body ?? ''));
    request.emit('end');
    return { request, response, result: await finished };
}

const jsonHeaders = { 'content-type': 'application/json' };

function runtimeWith(respond: (body: unknown, sessionId: string) => CompanionRuntimeResult | Promise<CompanionRuntimeResult>) {
    const calls: { body: unknown; sessionId: string }[] = [];
    let issued = 0;
    const runtime = {
        createSession: () => `session-${++issued}`,
        handle: async (body: unknown, sessionId: string) => {
            calls.push({ body, sessionId });
            return respond(body, sessionId);
        },
    } as unknown as CompanionRuntime;
    return { runtime, calls };
}

test('sessionFor：hello 一律由服务端签发新会话，不采信客户端自带的会话', () => {
    let issued = 0;
    const runtime = { createSession: () => `session-${++issued}` } as Pick<CompanionRuntime, 'createSession'>;
    assert.equal(sessionFor(runtime, { kind: 'hello' }, 'session-guess'), 'session-1');
    assert.equal(sessionFor(runtime, { kind: 'hello' }, undefined), 'session-2');
    assert.equal(issued, 2);
});

test('sessionFor：非 hello 原样带回已有会话，没有才签发；空 body 不当作 hello', () => {
    let issued = 0;
    const runtime = { createSession: () => `session-${++issued}` } as Pick<CompanionRuntime, 'createSession'>;
    assert.equal(sessionFor(runtime, { kind: 'message.send' }, 'session-known'), 'session-known');
    assert.equal(sessionFor(runtime, { kind: 'message.send' }, undefined), 'session-1');
    for (const body of [null, undefined, 42, 'hello', [], { kind: 'HELLO' }]) {
        assert.equal(sessionFor(runtime, body, 'session-known'), 'session-known');
    }
    assert.equal(issued, 1);
});

test('构造校验：路径与 body 上限必须合法', () => {
    const { runtime } = runtimeWith(() => ({ accepted: true }));
    for (const path of ['', 'relative', '/中文', '/a b', '/a?', `/${'a'.repeat(121)}`]) {
        assert.throws(() => createCompanionHttpHandler(runtime, { path }), /HTTP 路径不合法/);
    }
    for (const maxBodyBytes of [1023, 8 * 1024 * 1024 + 1, 1.5, Number.NaN]) {
        assert.throws(() => createCompanionHttpHandler(runtime, { maxBodyBytes }), /HTTP body 上限不合法/);
    }
    assert.doesNotThrow(() => createCompanionHttpHandler(runtime, { path: '/companion/test', maxBodyBytes: 1024 }));
});

test('路由：只看 query 之前的路径，路径不符返回 404', async () => {
    const pong: CompanionEnvelope = {
        v: 1,
        requestId: 'req-1',
        kind: 'hello',
        sentAt: '2026-11-26T12:00:00.000Z',
        nonce: 'nonce-1',
        body: { pong: true },
    };
    const { runtime, calls } = runtimeWith(() => ({ accepted: true, response: pong }));
    const handler = createCompanionHttpHandler(runtime, { path: '/companion/test' });
    const missing = await post(handler, { url: '/companion/other?x=1', headers: jsonHeaders, body: '{}' });
    assert.equal(missing.response.statusCode, 404);
    assert.deepEqual(JSON.parse(missing.response.body ?? ''), { error: 'not_found' });
    assert.deepEqual(calls, []);

    const matched = await post(handler, { url: '/companion/test?x=1', headers: jsonHeaders, body: '{"kind":"hello"}' });
    assert.equal(matched.response.statusCode, 200);
    assert.deepEqual(JSON.parse(matched.response.body ?? ''), pong);
    assert.equal(matched.response.headers['content-type'], 'application/json; charset=utf-8');
});

test('方法、重复会话头、Content-Type 和非法 JSON 各自返回对应错误', async () => {
    const { runtime } = runtimeWith(() => ({ accepted: true }));
    const handler = createCompanionHttpHandler(runtime);
    const get = await post(handler, { method: 'GET', headers: jsonHeaders });
    assert.equal(get.response.statusCode, 405);
    assert.equal(get.response.headers['allow'], 'POST');
    assert.deepEqual(JSON.parse(get.response.body ?? ''), { error: 'method_not_allowed' });

    const duplicate = await post(handler, { headers: { ...jsonHeaders, 'x-companion-session': ['a', 'b'] } });
    assert.equal(duplicate.response.statusCode, 400);
    assert.deepEqual(JSON.parse(duplicate.response.body ?? ''), { error: 'duplicate_session_header' });

    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
        const wrongType = await post(handler, { headers: contentType ? { 'content-type': contentType } : {} });
        assert.equal(wrongType.response.statusCode, 415);
        assert.deepEqual(JSON.parse(wrongType.response.body ?? ''), { error: 'content_type_must_be_json' });
    }

    const broken = await post(handler, { headers: jsonHeaders, body: '{ nope' });
    assert.equal(broken.response.statusCode, 400);
    assert.deepEqual(JSON.parse(broken.response.body ?? ''), { error: 'invalid_json' });
});

test('body 超限立即返回 413 并继续 drain，不再交给运行时', async () => {
    const { runtime, calls } = runtimeWith(() => ({ accepted: true }));
    const handler = createCompanionHttpHandler(runtime, { maxBodyBytes: 1024 });
    const oversized = await post(handler, { headers: jsonHeaders, body: JSON.stringify({ padding: 'x'.repeat(2000) }) });
    assert.equal(oversized.response.statusCode, 413);
    assert.deepEqual(JSON.parse(oversized.response.body ?? ''), { error: 'body_too_large' });
    assert.equal(oversized.request.resumed, true);
    assert.deepEqual(calls, []);

    const caseInsensitive = await post(handler, { headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: '{}' });
    assert.equal(caseInsensitive.response.statusCode, 204, '大小写和 charset 不影响 JSON Content-Type 的判定');
});

test('成功路径：hello 忽略伪造会话，其余请求带回原会话；无响应体时是 204', async () => {
    const { runtime, calls } = runtimeWith((_body, sessionId) => ({
        accepted: true,
        response: { kind: 'message.receive', sessionId },
    } as unknown as CompanionRuntimeResult));
    const handler = createCompanionHttpHandler(runtime, { path: '/companion/test' });

    const hello = await post(handler, {
        url: '/companion/test',
        headers: { ...jsonHeaders, 'x-companion-session': 'session-guess' },
        body: JSON.stringify({ kind: 'hello' }),
    });
    assert.equal(hello.response.statusCode, 200);
    assert.equal(hello.response.headers['x-companion-session'], 'session-1');
    assert.deepEqual(calls[0]?.sessionId, 'session-1');

    const followed = await post(handler, {
        url: '/companion/test',
        headers: { ...jsonHeaders, 'x-companion-session': 'session-1' },
        body: JSON.stringify({ kind: 'message.send' }),
    });
    assert.equal(followed.response.statusCode, 200);
    assert.deepEqual(calls[1]?.sessionId, 'session-1');

    const quiet = createCompanionHttpHandler(runtimeWith(() => ({ accepted: true })).runtime, { path: '/companion/test' });
    const noBody = await post(quiet, { url: '/companion/test', headers: jsonHeaders, body: '{}' });
    assert.equal(noBody.response.statusCode, 204);
    assert.equal(noBody.response.body, undefined);
});

test('运行时拒绝或抛错时映射为 400 / 500，不泄漏内部错误', async () => {
    const rejected = createCompanionHttpHandler(runtimeWith(() => ({ accepted: false, error: 'bad envelope' })).runtime);
    const bad = await post(rejected, { headers: jsonHeaders, body: '{}' });
    assert.equal(bad.response.statusCode, 400);
    assert.deepEqual(JSON.parse(bad.response.body ?? ''), { error: 'bad envelope' });

    const thrown = createCompanionHttpHandler(runtimeWith(() => { throw new Error('内部细节不能外泄'); }).runtime);
    const crashed = await post(thrown, { headers: jsonHeaders, body: '{}' });
    assert.equal(crashed.response.statusCode, 500);
    assert.deepEqual(JSON.parse(crashed.response.body ?? ''), { error: 'runtime_error' });
});
