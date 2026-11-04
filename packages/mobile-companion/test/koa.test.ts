import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { createCompanionKoaActionPollHandler, createCompanionKoaEnvelopeHandler, createCompanionKoaMediaHandler, type CompanionKoaContextLike } from '../src/koa.ts';
import { MemoryCompanionMediaStore } from '../src/media.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';

const png = (tail = '') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);

function context(body: unknown, headers: Record<string, string>, raw = Buffer.alloc(0)): CompanionKoaContextLike {
    const responseHeaders: Record<string, string> = {};
    return {
        path: '/qqbot/companion/http', method: 'POST', req: Readable.from(raw) as never,
        request: { body, headers }, status: 200, set: (name, value) => { responseHeaders[name.toLowerCase()] = value; },
        get responseHeaders() { return responseHeaders; },
    } as CompanionKoaContextLike & { responseHeaders: Record<string, string> };
}

test('Koishi Koa 适配器复用 envelope session，并能上传媒体', async () => {
    let now = 1_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-koa', now);
    const gateway = new CompanionGateway(pairing, () => now);
    const runtime = new CompanionRuntime(gateway, { onMessage: async message => ({ kind: 'text', text: message.text ?? '' }), onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }) }, () => now);
    const envelope = createCompanionKoaEnvelopeHandler(runtime);
    const media = new MemoryCompanionMediaStore({ now: () => now, id: () => '0123456789abcdef' });
    const upload = createCompanionKoaMediaHandler(runtime, media);
    const helloCtx = context(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'image'] }, 'req-koa-hello', 'nonce-koa-hello', new Date(now).toISOString()), {});
    await envelope(helloCtx);
    const helloHeaders = (helloCtx as CompanionKoaContextLike & { responseHeaders: Record<string, string> }).responseHeaders;
    assert.equal(helloCtx.status, 204);
    assert.match(helloHeaders['x-companion-session'] ?? '', /^session-/);
    const messageCtx = context({ v: 1, requestId: 'req-koa-message', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-koa-message', body: { kind: 'text', text: '你好' } }, { 'x-companion-session': helloHeaders['x-companion-session']! });
    await envelope(messageCtx);
    assert.equal(messageCtx.status, 200);
    runtime.requestPhoneAction('android-koa', { action: 'notify', params: { text: '你好' }, decision: 'confirm' }, 'push-koa-action');
    const poll = createCompanionKoaActionPollHandler(runtime);
    const pollCtx = context(undefined, { 'x-companion-session': helloHeaders['x-companion-session']! });
    pollCtx.path = '/qqbot/companion/http/actions';
    pollCtx.method = 'GET';
    await poll(pollCtx);
    assert.equal(pollCtx.status, 200);
    assert.deepEqual((pollCtx.body as { actions: Array<{ requestId: string }> }).actions.map(action => action.requestId), ['push-koa-action']);
    const emptyPoll = context(undefined, { 'x-companion-session': helloHeaders['x-companion-session']! });
    emptyPoll.path = '/qqbot/companion/http/actions';
    emptyPoll.method = 'GET';
    await poll(emptyPoll);
    assert.deepEqual((emptyPoll.body as { actions: unknown[] }).actions, []);
    const uploadData = png('koa-image');
    const uploadCtx = context(undefined, { 'x-companion-session': helloHeaders['x-companion-session']!, 'x-companion-mime': 'image/png' }, uploadData);
    uploadCtx.path = '/qqbot/companion/http/media';
    await upload(uploadCtx);
    assert.equal(uploadCtx.status, 201);
    assert.deepEqual(media.get('android-koa', '0123456789abcdef')?.data, uploadData);
    const svgCtx = context(undefined, { 'x-companion-session': helloHeaders['x-companion-session']!, 'x-companion-mime': 'image/svg+xml' }, Buffer.from('<svg/>'));
    svgCtx.path = '/qqbot/companion/http/media';
    await upload(svgCtx);
    assert.equal(svgCtx.status, 415);
});

test('Koishi Koa 适配器拒绝过大的 envelope 和媒体 body', async () => {
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-koa-limit', 1_000);
    const gateway = new CompanionGateway(pairing, () => 1_000);
    const runtime = new CompanionRuntime(gateway, { onMessage: async message => message, onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }) }, () => 1_000);
    const envelope = createCompanionKoaEnvelopeHandler(runtime, { maxBodyBytes: 1_024 });
    const large = context({ huge: 'x'.repeat(2_000) }, {});
    await envelope(large);
    assert.equal(large.status, 413);
    const media = new MemoryCompanionMediaStore({ now: () => 1_000 });
    const upload = createCompanionKoaMediaHandler(runtime, media, { maxBodyBytes: 1_024 });
    const hello = helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'image'] }, 'req-koa-limit-hello', 'nonce-koa-limit-hello', new Date(1_000).toISOString());
    const helloCtx = context(hello, {});
    const helloHandler = createCompanionKoaEnvelopeHandler(runtime, { maxBodyBytes: 1_024 });
    await helloHandler(helloCtx);
    const session = (helloCtx as CompanionKoaContextLike & { responseHeaders: Record<string, string> }).responseHeaders['x-companion-session'];
    assert.ok(session);
    const oversized = context(undefined, { 'x-companion-session': session, 'x-companion-mime': 'image/png' }, Buffer.alloc(2_000));
    oversized.path = '/qqbot/companion/http/media';
    await upload(oversized);
    assert.equal(oversized.status, 413);
});

test('媒体上传读取期间解绑，不会让旧设备媒体在清理后重新出现', async () => {
    const now = 2_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-koa-reset', now);
    const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
        onMessage: async message => message,
        onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }),
    }, () => now);
    const helloCtx = context(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['image'] }, 'req-koa-reset-hello', 'nonce-koa-reset-hello', new Date(now).toISOString()), {});
    await createCompanionKoaEnvelopeHandler(runtime)(helloCtx);
    const session = (helloCtx as CompanionKoaContextLike & { responseHeaders: Record<string, string> }).responseHeaders['x-companion-session']!;
    const stream = new PassThrough();
    const uploadCtx = context(undefined, { 'x-companion-session': session, 'x-companion-mime': 'image/png' });
    uploadCtx.path = '/qqbot/companion/http/media';
    uploadCtx.req = stream as never;
    const media = new MemoryCompanionMediaStore({ now: () => now, id: () => 'fedcba9876543210' });
    const pending = createCompanionKoaMediaHandler(runtime, media)(uploadCtx);
    stream.write(Buffer.from('old-session-image'));
    await new Promise(resolve => setTimeout(resolve, 0));
    runtime.reset();
    stream.end();
    await pending;
    assert.equal(uploadCtx.status, 401);
    assert.deepEqual(uploadCtx.body, { error: 'session_expired' });
    assert.equal(media.get(ticket.clientId, 'fedcba9876543210'), undefined);
});

test('Koishi Koa envelope 拒绝空 body 而不抛异常', async () => {
    const runtime = new CompanionRuntime(new CompanionGateway(new MemoryPairingStore()), { onMessage: async message => message, onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }) });
    const ctx = context(undefined, {});
    await createCompanionKoaEnvelopeHandler(runtime)(ctx);
    assert.equal(ctx.status, 400);
    assert.deepEqual(ctx.body, { error: 'invalid_json' });
});
