import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { createCompanionKoaActionPollHandler, createCompanionKoaEnvelopeHandler, createCompanionKoaMediaHandler, type CompanionKoaContextLike } from '../src/koa.ts';
import { MemoryCompanionMediaStore } from '../src/media.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';

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
    const uploadCtx = context(undefined, { 'x-companion-session': helloHeaders['x-companion-session']!, 'x-companion-mime': 'image/png' }, Buffer.from('koa-image'));
    uploadCtx.path = '/qqbot/companion/http/media';
    await upload(uploadCtx);
    assert.equal(uploadCtx.status, 201);
    assert.equal(media.get('android-koa', '0123456789abcdef')?.data.toString(), 'koa-image');
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

test('Koishi Koa envelope 拒绝空 body 而不抛异常', async () => {
    const runtime = new CompanionRuntime(new CompanionGateway(new MemoryPairingStore()), { onMessage: async message => message, onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }) });
    const ctx = context(undefined, {});
    await createCompanionKoaEnvelopeHandler(runtime)(ctx);
    assert.equal(ctx.status, 400);
    assert.deepEqual(ctx.body, { error: 'invalid_json' });
});

test('宿主停止后残留 Koa 路由只拒绝请求，不复活会话或媒体', async () => {
    const now = 2_000, pairing = new MemoryPairingStore(60_000), ticket = pairing.issue('android-koa-stop', now);
    const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
        onMessage: async message => message,
        onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }),
    }, () => now);
    const media = new MemoryCompanionMediaStore({ now: () => now });
    const envelope = createCompanionKoaEnvelopeHandler(runtime), upload = createCompanionKoaMediaHandler(runtime, media), poll = createCompanionKoaActionPollHandler(runtime);
    const helloCtx = context(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'image'] }, 'req-koa-stop-hello', 'nonce-koa-stop-hello', new Date(now).toISOString()), {});
    await envelope(helloCtx);
    const session = (helloCtx as CompanionKoaContextLike & { responseHeaders: Record<string, string> }).responseHeaders['x-companion-session']; assert.ok(session);
    await runtime.stop(); media.stop(); pairing.stop();

    const staleMessage = context({ v: 1, requestId: 'req-koa-stop-message', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-koa-stop-message', body: { kind: 'text', text: '停止后' } }, { 'x-companion-session': session });
    await envelope(staleMessage); assert.equal(staleMessage.status, 400); assert.deepEqual(staleMessage.body, { error: '手机伴侣已经停止' });
    const staleUpload = context(undefined, { 'x-companion-session': session, 'x-companion-mime': 'image/png' }, Buffer.from('private'));
    staleUpload.path = '/qqbot/companion/http/media'; await upload(staleUpload); assert.equal(staleUpload.status, 401);
    const stalePoll = context(undefined, { 'x-companion-session': session }); stalePoll.path = '/qqbot/companion/http/actions'; stalePoll.method = 'GET';
    await poll(stalePoll); assert.equal(stalePoll.status, 401);

    const newHello = context(helloEnvelope({ clientId: 'android-koa-new', pairingCode: 'AAAA-BBBB-CCCC', capabilities: ['text'] }, 'req-koa-stop-new', 'nonce-koa-stop-new', new Date(now).toISOString()), {});
    await envelope(newHello); assert.equal(newHello.status, 400); assert.deepEqual(newHello.body, { error: '手机伴侣已经停止' });
});
