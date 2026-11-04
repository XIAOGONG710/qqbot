import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { actionNeedsConfirmation, decidePhoneAction } from '../src/action-policy.ts';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime, DOWNLINK_ACTION_TTL_MS, MAX_DOWNLINK_ACTIONS } from '../src/runtime.ts';
import { createCompanionHttpHandler } from '../src/http.ts';
import { attachCompanionWebSocket } from '../src/websocket.ts';
import { createServer, request as httpRequest } from 'node:http';
import { CompanionClient } from '../src/client.ts';
import { createDshCompanionHandlers } from '../src/dsh-adapter.ts';
import { MAX_CLOCK_SKEW_MS, validateAction, validateActionResult, validateEnvelope, validateHello, validateMessage, type ActionResult, type CompanionMessage } from '../src/protocol.ts';

describe('手机伴侣协议', () => {
    test('接受文字、语音、图片和服务端表情 id', () => {
        assert.equal(validateMessage({ kind: 'text', text: '在吗' }).kind, 'text');
        assert.equal(validateMessage({ kind: 'audio', media: { mediaId: 'abcdef0123456789', mime: 'audio/ogg', bytes: 12 } }).kind, 'audio');
        assert.equal(validateMessage({ kind: 'sticker', stickerId: 'abcdef0123456789', media: { mediaId: 'abcdef0123456789', mime: 'image/webp', bytes: 12 } }).kind, 'sticker');
    });

    test('拒绝本地路径、超大媒体和任意表情 URL', () => {
        assert.throws(() => validateMessage({ kind: 'image', media: { url: 'file:///secret.png', mime: 'image/png', bytes: 12 } }));
        assert.throws(() => validateMessage({ kind: 'audio', media: { mediaId: 'abcdef0123456789', mime: 'audio/ogg', bytes: 9_000_000 } }));
        assert.throws(() => validateMessage({ kind: 'sticker', stickerId: 'not-a-catalog-id', media: { mediaId: 'abcdef0123456789', mime: 'image/webp', bytes: 12 } }));
        assert.throws(() => validateMessage({ kind: 'image', media: { url: 'https://cdn.example/image.png', mediaId: 'abcdef0123456789', mime: 'image/png', bytes: 12 } }));
        assert.throws(() => validateMessage({ kind: 'image', media: { url: 'https://user:password@cdn.example/image.png', mime: 'image/png', bytes: 12 } }), /账号密码/);
        assert.throws(() => validateMessage({ kind: 'image', media: { url: 'https://', mime: 'image/png', bytes: 12 } }), /只允许 https/);
        assert.throws(() => validateMessage({ kind: 'image', media: { mediaId: 'abcdef0123456789', mime: 'image/png', bytes: 12, width: 0, height: 9000 } }));
        assert.throws(() => validateMessage({ kind: 'audio', media: { mediaId: 'abcdef0123456789', mime: 'audio/ogg', bytes: 12, durationMs: 2 * 60 * 60_000 + 1 } }));
        assert.throws(() => validateMessage({ kind: 'audio', media: { mediaId: 'abcdef0123456789', mime: 'image/png', bytes: 12 } }));
        assert.throws(() => validateMessage({ kind: 'image', media: { mediaId: 'abcdef0123456789', mime: 'audio/ogg', bytes: 12 } }));
    });

    test('协议包检查时间、nonce 和类型', () => {
        const now = Date.now();
        assert.equal(validateEnvelope({ v: 1, requestId: 'req-123456', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-123456', body: { kind: 'text', text: 'hi' } }, now).kind, 'message.send');
        assert.throws(() => validateEnvelope({ v: 1, requestId: 'req-123456', kind: 'message.send', sentAt: new Date(now - 10 * 60_000).toISOString(), nonce: 'nonce-123456', body: {} }, now));
        assert.throws(() => validateEnvelope({ v: 1, requestId: 'req-123456', kind: 'action.request', sentAt: new Date(now).toISOString(), nonce: 'nonce-123456', body: { action: 'shell', params: {}, decision: 'auto' } }, now));
    });

    test('首次连接使用短期配对码和能力列表', () => {
        const hello = validateHello({ clientId: 'android-123456', pairingCode: 'ABCD-1234', capabilities: ['text', 'audio', 'image', 'sticker'] });
        assert.equal(hello.clientId, 'android-123456');
        assert.throws(() => validateHello({ clientId: 'android-123456', pairingCode: 'too-short', capabilities: ['text'] }));
        assert.throws(() => validateHello({ clientId: 'android-123456', pairingCode: 'ABCD-1234', capabilities: ['shell'] }));
        assert.throws(() => validateHello({ clientId: 'android-123456', pairingCode: 'ABCD-1234', capabilities: ['text', 'text'] }));
        assert.throws(() => validateHello({ clientId: 'android-123456', pairingCode: 'ABCD-1234', capabilities: ['text', 'audio', 'image', 'sticker', 'text'] }));
    });

    test('设备动作只能走白名单和确认策略', () => {
        const request = validateAction({ action: 'open_link', targetId: 'music-1', params: {}, decision: 'confirm' });
        assert.equal(actionNeedsConfirmation(request.action), true);
        assert.equal(decidePhoneAction(request, false), 'deny');
        assert.equal(decidePhoneAction(request, true), 'confirm');
        assert.equal(decidePhoneAction({ action: 'notify', params: { text: '晚安' }, decision: 'auto' }, false), 'auto');
        assert.equal(decidePhoneAction({ action: 'notify', params: { text: '晚安' }, decision: 'confirm' }, false), 'deny');
        assert.equal(decidePhoneAction({ action: 'notify', params: { text: '晚安' }, decision: 'confirm' }, true), 'confirm');
        assert.throws(() => validateAction({ action: 'ring', params: {}, decision: 'auto' }), /不能降级/);
        assert.doesNotThrow(() => validateAction({ action: 'notify', params: {}, decision: 'confirm' }));
        assert.throws(() => validateAction({ action: 'shell', params: { command: 'whoami' }, decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: { text: { nested: true } }, decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: { 'bad key': 'x' }, decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: { constructor: 'x' }, decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: { count: Number.NaN }, decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`p${index}`, 'x'])), decision: 'auto' }));
        assert.throws(() => validateAction({ action: 'notify', params: {}, decision: 'auto', reason: { bad: true } }));
        assert.throws(() => validateAction({ action: 'notify', params: {}, decision: 'auto', reason: 'x'.repeat(501) }));
        assert.throws(() => validateActionResult({ requestId: 'req-123456', ok: false, decision: 'deny', error: 'x'.repeat(501) }));
    });

    test('网关先一次性配对，再接受消息并拒绝重放', () => {
        const used = new Set<string>();
        const gateway = new CompanionGateway({ consume: (clientId, code) => {
            const key = `${clientId}:${code}`;
            if (used.has(key) || code !== 'ABCD-1234') return false;
            used.add(key);
            return true;
        } });
        const hello = helloEnvelope({ clientId: 'android-123456', pairingCode: 'ABCD-1234', capabilities: ['text'] }, 'req-hello', 'nonce-hello');
        assert.deepEqual(gateway.accept(hello), { ok: true, clientId: 'android-123456', kind: 'hello' });
        const helloReplay = gateway.accept(hello);
        assert.equal(helloReplay.ok, false);
        if (!helloReplay.ok) assert.match(helloReplay.error, /nonce|配对码/);
        assert.deepEqual(gateway.accept({ v: 1, requestId: 'req-msg123', kind: 'message.send', sentAt: new Date().toISOString(), nonce: 'nonce-msg123', body: { kind: 'text', text: '在吗' } }), { ok: true, clientId: 'android-123456', kind: 'message.send' });
        const replay = gateway.accept({ v: 1, requestId: 'req-msg124', kind: 'message.send', sentAt: new Date().toISOString(), nonce: 'nonce-msg123', body: { kind: 'text', text: '重复' } });
        assert.equal(replay.ok, false);
        if (!replay.ok) assert.match(replay.error, /nonce/);
        const otherSession = gateway.accept({ v: 1, requestId: 'req-msg125', kind: 'message.send', sentAt: new Date().toISOString(), nonce: 'nonce-msg125', body: { kind: 'text', text: '另一条连接' } }, 'other-session');
        assert.equal(otherSession.ok, false);
        if (!otherSession.ok) assert.match(otherSession.error, /连接/);
        const other = new CompanionGateway({ consume: () => true });
        const unpaired = other.accept({ v: 1, requestId: 'req-msg123', kind: 'message.send', sentAt: new Date().toISOString(), nonce: 'nonce-msg123', body: { kind: 'text', text: '未配对' } });
        assert.equal(unpaired.ok, false);
        if (!unpaired.ok) assert.match(unpaired.error, /尚未配对/);
    });

    test('高频请求不会在时钟偏差窗口内淘汰旧 nonce', () => {
        const now = 20_000;
        const gateway = new CompanionGateway({ consume: () => true }, () => now);
        assert.equal(gateway.accept(helloEnvelope({ clientId: 'android-window', pairingCode: 'ABCD-1234', capabilities: ['text'] }, 'req-window-hello', 'nonce-window-hello', new Date(now).toISOString())).ok, true);
        for (let index = 0; index < 300; index += 1) {
            const suffix = index.toString().padStart(4, '0');
            assert.equal(gateway.accept({
                v: 1,
                requestId: `req-window-${suffix}`,
                kind: 'message.send',
                sentAt: new Date(now).toISOString(),
                nonce: `nonce-window-${suffix}`,
                body: { kind: 'text', text: suffix },
            }).ok, true);
        }
        const replay = gateway.accept({
            v: 1,
            requestId: 'req-window-replay',
            kind: 'message.send',
            sentAt: new Date(now).toISOString(),
            nonce: 'nonce-window-0000',
            body: { kind: 'text', text: '重复' },
        });
        assert.equal(replay.ok, false);
        if (!replay.ok) assert.match(replay.error, /nonce/);
    });

    test('默认配对存储支持过期、替换和消费即失效', () => {
        const store = new MemoryPairingStore(10_000);
        const first = store.issue('android-123456', 1_000);
        assert.match(first.pairingCode, /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/);
        const replacement = store.issue('android-123456', 2_000);
        assert.equal(store.consume('android-123456', first.pairingCode, 2_001), false);
        assert.equal(store.consume('android-123456', replacement.pairingCode, 2_001), true);
        assert.equal(store.consume('android-123456', replacement.pairingCode, 2_002), false);

        const expired = store.issue('android-expire', 3_000);
        assert.equal(store.consume('android-expire', expired.pairingCode, expired.expiresAt), false);
        const revoked = store.issue('android-revoke', 4_000);
        store.revoke('android-revoke');
        assert.equal(store.consume('android-revoke', revoked.pairingCode, 4_001), false);
        const pendingA = store.issue('android-pending-a', 5_000);
        const pendingB = store.issue('android-pending-b', 5_001);
        assert.equal(store.clear(), 2);
        assert.equal(store.consume(pendingA.clientId, pendingA.pairingCode, 5_002), false);
        assert.equal(store.consume(pendingB.clientId, pendingB.pairingCode, 5_002), false);
    });

    test('未使用配对码有数量上限，重复点配对不会无限增长', () => {
        const store = new MemoryPairingStore(60_000);
        const first = store.issue('android-old-1', 10_000);
        let latest = first;
        for (let index = 0; index < 64; index += 1) latest = store.issue(`android-${String(index).padStart(6, '0')}`, 10_001 + index);
        assert.equal(store.consume(first.clientId, first.pairingCode, 10_100), false);
        assert.equal(store.consume(latest.clientId, latest.pairingCode, 10_100), true);
    });

    test('运行时把消息和动作交给宿主，并返回统一 envelope', async () => {
        let now = 10_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-123456', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => ({ kind: 'text', text: `收到：${message.text ?? message.kind}` }),
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: request.action === 'notify', decision: request.decision }),
        }, () => now);
        const hello = helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-hello', 'nonce-hello', new Date(now).toISOString());
        assert.equal((await runtime.handle(hello)).accepted, true);
        const message = await runtime.handle({ v: 1, requestId: 'req-msg123', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-msg123', body: { kind: 'text', text: '你好' } });
        assert.equal(message.accepted, true);
        if (message.accepted) {
            assert.equal(message.response?.kind, 'message.receive');
            assert.equal((message.response?.body as { text?: string }).text, '收到：你好');
        }
        now += 1;
        const action = await runtime.handle({ v: 1, requestId: 'req-act123', kind: 'action.request', sentAt: new Date(now).toISOString(), nonce: 'nonce-act123', body: { action: 'notify', params: { text: '晚安' }, decision: 'auto' } });
        assert.equal(action.accepted, true);
        if (action.accepted) assert.equal(action.response?.kind, 'action.result');
    });

    test('HTTPS 长时间空闲后可用新配对码回收旧会话', () => {
        let now = 40_000;
        const pairing = new MemoryPairingStore(60_000);
        const first = pairing.issue('android-idle', now);
        const gateway = new CompanionGateway(pairing, () => now, { sessionIdleTtlMs: 60_000 });
        const hello = helloEnvelope({ clientId: first.clientId, pairingCode: first.pairingCode, capabilities: ['text'] }, 'req-idle-1', 'nonce-idle-1', new Date(now).toISOString());
        assert.equal(gateway.accept(hello, 'session-old').ok, true);
        assert.equal(gateway.connected, true);
        now += 60_001;
        assert.equal(gateway.connected, false, '状态读取应立即清理已过期的空闲会话');
        assert.equal(gateway.pairedClientId, 'android-idle', '只释放传输会话，仍保留已配对设备身份');
        const stale = gateway.accept({ v: 1, requestId: 'req-idle-2', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-idle-2', body: { kind: 'text', text: 'stale' } }, 'session-old');
        assert.equal(stale.ok, false);
        const second = pairing.issue('android-idle', now);
        const renewed = gateway.accept(helloEnvelope({ clientId: second.clientId, pairingCode: second.pairingCode, capabilities: ['text'] }, 'req-idle-3', 'nonce-idle-3', new Date(now).toISOString()), 'session-new');
        assert.deepEqual(renewed, { ok: true, clientId: 'android-idle', kind: 'hello' });
    });

    test('HTTPS 的有效轮询会刷新会话活跃时间，真正空闲后仍会过期', () => {
        let now = 50_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-poll', now);
        const gateway = new CompanionGateway(pairing, () => now, { sessionIdleTtlMs: 60_000 });
        assert.equal(gateway.accept(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-poll-1', 'nonce-poll-1', new Date(now).toISOString()), 'session-poll').ok, true);
        now += 59_000;
        assert.equal(gateway.clientForSession('session-poll'), 'android-poll');
        now += 59_000;
        assert.equal(gateway.clientForSession('session-poll'), 'android-poll');
        now += 60_001;
        assert.equal(gateway.clientForSession('session-poll'), undefined);
    });

    test('系统时钟明显回拨后会话和配对码失败关闭', () => {
        let now = 1_000_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-clock', now);
        const gateway = new CompanionGateway(pairing, () => now, { sessionIdleTtlMs: 60_000 });
        assert.equal(gateway.accept(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-clock-hello', 'nonce-clock-hello', new Date(now).toISOString()), 'session-clock').ok, true);
        now -= MAX_CLOCK_SKEW_MS + 1;
        assert.equal(gateway.clientForSession('session-clock'), undefined);
        const replacement = pairing.issue('android-clock-next', 1_000_000);
        assert.equal(pairing.consume(replacement.clientId, replacement.pairingCode, now), false);
    });

    test('HTTP 适配器限制路径、方法、类型和 body 大小', async () => {
        let now = 20_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-http', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => ({ kind: 'text', text: message.text ?? '' }),
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: true, decision: request.decision }),
        }, () => now);
        const server = createServer(createCompanionHttpHandler(runtime, { path: '/companion/test', maxBodyBytes: 4_096 }));
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        try {
            const wrongMethod = await fetch(`${base}/companion/test`, { method: 'GET' });
            assert.equal(wrongMethod.status, 405);
            const wrongType = await fetch(`${base}/companion/test`, { method: 'POST', body: 'x' });
            assert.equal(wrongType.status, 415);
            const tooLarge = await fetch(`${base}/companion/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(5_000) }) });
            assert.equal(tooLarge.status, 413);
            const duplicateSession = await new Promise<number>((resolve, reject) => {
                const request = httpRequest(new URL(`${base}/companion/test`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-companion-session': ['session-one', 'session-two'] } }, response => {
                    response.resume();
                    response.once('end', () => resolve(response.statusCode ?? 0));
                });
                request.once('error', reject);
                request.end('{}');
            });
            assert.equal(duplicateSession, 400);
            const hello = helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-http1', 'nonce-http1', new Date(now).toISOString());
            const ok = await fetch(`${base}/companion/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hello) });
            assert.equal(ok.status, 204);
            const session = ok.headers.get('x-companion-session');
            assert.match(session ?? '', /^session-[a-f0-9]{36}$/);
            now += 1;
            const message = await fetch(`${base}/companion/test`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-companion-session': session! }, body: JSON.stringify({ v: 1, requestId: 'req-http2', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-http2', body: { kind: 'text', text: 'hi' } }) });
            assert.equal(message.status, 200);
            assert.equal((await message.json() as { kind?: string }).kind, 'message.receive');
            const hijack = await fetch(`${base}/companion/test`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-companion-session': 'session-hijack' }, body: JSON.stringify({ v: 1, requestId: 'req-http3', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-http3', body: { kind: 'text', text: 'hijack' } }) });
            assert.equal(hijack.status, 400);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test('WebSocket 适配器只接受受限文本帧，并复用运行时响应', async () => {
        let now = 21_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-ws', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => ({ kind: 'text', text: `WS:${message.text ?? ''}` }),
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: true, decision: request.decision }),
        }, () => now);
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const sent: string[] = [];
        const closed: Array<[number | undefined, string | undefined]> = [];
        const socket = {
            on: (event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
            send: (data: string) => sent.push(data),
            close: (code?: number, reason?: string) => closed.push([code, reason]),
        };
        attachCompanionWebSocket(socket, runtime, { maxMessageBytes: 2_048 });
        const emit = async (data: unknown) => { listeners.get('message')?.(data); await new Promise(resolve => setTimeout(resolve, 0)); };
        await emit(JSON.stringify(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-ws1', 'nonce-ws1', new Date(now).toISOString())));
        runtime.requestPhoneAction('android-ws', { action: 'ring', params: { durationMs: 300 }, decision: 'confirm' }, 'push-ws-action');
        assert.equal(JSON.parse(sent.at(-1)!).kind, 'action.request');
        assert.deepEqual(runtime.takeDownlinks('android-ws'), []);
        now += 1;
        await emit(JSON.stringify({ v: 1, requestId: 'req-ws2', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-ws2', body: { kind: 'text', text: '你好' } }));
        assert.equal(JSON.parse(sent.at(-1)!).body.text, 'WS:你好');
        await emit('{');
        assert.deepEqual(closed.at(-1), [1003, 'invalid_json']);
        listeners.get('close')?.();
        await emit(JSON.stringify({ v: 1, requestId: 'req-ws3', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-ws3', body: { kind: 'text', text: '关闭后不处理' } }));
        assert.equal(sent.filter(item => item.includes('关闭后不处理')).length, 0);
        const binaryListeners = new Map<string, (...args: unknown[]) => void>();
        const binaryClosed: Array<[number | undefined, string | undefined]> = [];
        const binarySocket = {
            on: (event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void) => { binaryListeners.set(event, listener); },
            send: (_data: string) => undefined,
            close: (code?: number, reason?: string) => binaryClosed.push([code, reason]),
        };
        attachCompanionWebSocket(binarySocket, runtime);
        binaryListeners.get('message')?.(Buffer.from('{}'), true);
        assert.deepEqual(binaryClosed, [[1003, 'message_must_be_text']]);
    });

    test('客户端关联响应 requestId，并拒绝未知响应', () => {
        let now = 30_000;
        const nonces = ['client-hello', 'client-message'];
        const client = new CompanionClient({ clientId: 'android-client', pairingCode: 'ABCD-1234', capabilities: ['text'], now: () => now, nonce: () => nonces.shift() ?? 'client-fallback' });
        assert.equal(client.hello('req-client-hello').kind, 'hello');
        const sent = client.sendMessage({ kind: 'text', text: '你好' }, 'req-client-msg');
        assert.equal(client.pendingCount, 1);
        const received = client.accept({ v: 1, requestId: 'resp-req-client-msg', kind: 'message.receive', sentAt: new Date(now).toISOString(), nonce: 'server-response', body: { kind: 'text', text: '嗯，在呢' } });
        assert.equal(received.kind, 'message.receive');
        assert.equal(client.pendingCount, 0);
        assert.equal(sent.body.text, '你好');
        const downlink = client.acceptDownlink({ v: 1, requestId: 'push-client-action', kind: 'action.request', sentAt: new Date(now).toISOString(), nonce: 'server-action', body: { action: 'ring', params: { durationMs: 300 }, decision: 'confirm' } });
        assert.equal(downlink.body.action, 'ring');
        assert.throws(() => client.accept({ v: 1, requestId: 'resp-unknown', kind: 'message.receive', sentAt: new Date(now).toISOString(), nonce: 'server-unknown', body: { kind: 'text', text: 'x' } }));
        assert.throws(() => client.sendMessage({ kind: 'text', text: '重复' }, 'req-client-msg'));
        let nonceIndex = 0;
        const limited = new CompanionClient({ clientId: 'android-limited', pairingCode: 'ABCD-1234', capabilities: ['text'], now: () => now, nonce: () => `client-limited-${nonceIndex++}` });
        for (let index = 0; index < 32; index += 1) limited.sendMessage({ kind: 'text', text: `${index}` }, `req-limited-${index}`);
        assert.throws(() => limited.sendMessage({ kind: 'text', text: '33' }, 'req-limited-33'));
        limited.reset();
        assert.equal(limited.pendingCount, 0);
        assert.equal(limited.transportSessionId, undefined);
        assert.throws(() => limited.setTransportSession('bad'));
        limited.setTransportSession('session-0123456789abcdef0123456789abcdef');
        assert.equal(limited.transportSessionId, 'session-0123456789abcdef0123456789abcdef');
        limited.clearTransportSession();
        assert.equal(limited.transportSessionId, undefined);
        assert.equal(limited.hello('req-limited-0').kind, 'hello');
    });

    test('客户端拒绝重复 nonce，运行时拒绝客户端伪造的响应包', async () => {
        let now = 35_000;
        const client = new CompanionClient({ clientId: 'android-client', pairingCode: 'ABCD-1234', capabilities: ['text'], now: () => now, nonce: () => 'client-fixed' });
        assert.equal(client.hello('req-client-fixed').kind, 'hello');
        assert.throws(() => client.hello('req-client-fixed-2'));
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-direction', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => ({ kind: 'text', text: message.text ?? '' }),
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: true, decision: request.decision }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-direction-hello', 'nonce-direction-hello', new Date(now).toISOString()));
        const result = await runtime.handle({ v: 1, requestId: 'req-direction-receive', kind: 'message.receive', sentAt: new Date(now).toISOString(), nonce: 'nonce-direction-receive', body: { kind: 'text', text: '伪造' } });
        assert.equal(result.accepted, true);
        if (result.accepted) assert.match(String(result.response?.body && (result.response.body as { message?: string }).message), /客户端不能发送/);
    });

    test('未知响应不能挤掉客户端已经登记的下行动作 nonce', () => {
        let now = 35_000;
        const client = new CompanionClient({ clientId: 'android-replay-window', pairingCode: 'ABCD-1234', capabilities: ['text'], now: () => now });
        const downlink = { v: 1 as const, requestId: 'push-replay-window', kind: 'action.request' as const, sentAt: new Date(now).toISOString(), nonce: 'server-protected-nonce', body: { action: 'notify' as const, params: { text: '只执行一次' }, decision: 'auto' as const } };
        client.acceptDownlink(downlink);
        for (let index = 0; index < 300; index += 1) {
            assert.throws(() => client.accept({ v: 1, requestId: `resp-unknown-${index}`, kind: 'error', sentAt: new Date(now).toISOString(), nonce: `server-noise-${index}`, body: { code: 'noise-error', message: 'x' } }), /没有对应/);
        }
        assert.throws(() => client.acceptDownlink(downlink), /nonce 已经使用/);
        now += MAX_CLOCK_SKEW_MS + 1;
        assert.doesNotThrow(() => client.acceptDownlink({ ...downlink, sentAt: new Date(now).toISOString() }));
    });

    test('运行时错误响应保留原始 requestId', async () => {
        let now = 40_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-error', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async () => { throw new Error('宿主暂时不可用'); },
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: true, decision: request.decision }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-error-hello', 'nonce-error-hello', new Date(now).toISOString()));
        const result = await runtime.handle({ v: 1, requestId: 'req-error-msg', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-error-msg', body: { kind: 'text', text: 'hi' } });
        assert.equal(result.accepted, true);
        if (result.accepted) assert.equal(result.response?.requestId, 'resp-req-error-msg');
    });

    test('网关 reset 后旧会话失效，可重新配对', () => {
        let now = 50_000;
        const pairing = new MemoryPairingStore(60_000);
        const first = pairing.issue('android-reset', now);
        const gateway = new CompanionGateway(pairing, () => now);
        assert.equal(gateway.accept(helloEnvelope({ clientId: first.clientId, pairingCode: first.pairingCode, capabilities: ['text'] }, 'req-reset-1', 'nonce-reset-1', new Date(now).toISOString())).ok, true);
        gateway.reset();
        const blocked = gateway.accept({ v: 1, requestId: 'req-reset-msg', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-reset-msg', body: { kind: 'text', text: '旧会话' } });
        assert.equal(blocked.ok, false);
        const second = pairing.issue('android-reset', now + 1);
        now += 1;
        assert.equal(gateway.accept(helloEnvelope({ clientId: second.clientId, pairingCode: second.pairingCode, capabilities: ['text'] }, 'req-reset-2', 'nonce-reset-2', new Date(now).toISOString())).ok, true);
    });

    test('释放旧会话后可使用新配对码重连', () => {
        let now = 55_000;
        const pairing = new MemoryPairingStore(60_000);
        const first = pairing.issue('android-reconnect', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const firstSession = 'session-first';
        assert.equal(gateway.accept(helloEnvelope({ clientId: first.clientId, pairingCode: first.pairingCode, capabilities: ['text'] }, 'req-reconnect-1', 'nonce-reconnect-1', new Date(now).toISOString()), firstSession).ok, true);
        assert.equal(gateway.connected, true);
        assert.equal(gateway.releaseSession(firstSession), true);
        assert.equal(gateway.connected, false);
        const second = pairing.issue('android-reconnect', now + 1);
        now += 1;
        assert.equal(gateway.accept(helloEnvelope({ clientId: second.clientId, pairingCode: second.pairingCode, capabilities: ['text'] }, 'req-reconnect-2', 'nonce-reconnect-2', new Date(now).toISOString()), 'session-second').ok, true);
        assert.equal(gateway.releaseSession('session-other'), false);
    });

    test('DSH 伴侣适配器按设备保留有限上下文，并默认拒绝动作', async () => {
        const requests: Array<{ question: string; recentTurns?: readonly { role: string; content: string }[]; voice?: string }> = [];
        const handlers = createDshCompanionHandlers<unknown, string>({
            advisor: { advise: async request => { requests.push({ question: request.question, recentTurns: request.recentTurns, voice: request.voice }); return `她的口吻：${request.question}`; } },
            voice: clientId => `voice-${clientId}`,
            maxTurns: 4,
        });
        const first = await handlers.onMessage({ kind: 'text', text: '在吗' }, 'android-a');
        const second = await handlers.onMessage({ kind: 'text', text: '我今天有点累' }, 'android-a');
        const other = await handlers.onMessage({ kind: 'text', text: '你好' }, 'android-b');
        assert.equal(first.text, '她的口吻：在吗');
        assert.equal(second.text, '她的口吻：我今天有点累');
        assert.equal(other.text, '她的口吻：你好');
        assert.equal(requests[1]?.recentTurns?.length, 2);
        assert.equal(requests[1]?.voice, 'voice-android-a');
        const action = await handlers.onAction({ action: 'notify', params: { text: 'x' }, decision: 'auto' }, 'android-a', 'companion-action-request');
        assert.equal(action.ok, false);
        assert.equal(action.decision, 'deny');
        assert.equal(action.requestId, 'companion-action-request');
    });

    test('DSH 伴侣上下文按设备数量设上限并淘汰最旧设备', async () => {
        const requests: string[] = [];
        const handlers = createDshCompanionHandlers({
            maxClients: 2,
            advisor: { advise: async request => { requests.push(request.recentTurns?.map(turn => turn.content).join('|') ?? ''); return request.question; } },
        });
        await handlers.onMessage({ kind: 'text', text: 'a-1' }, 'android-a');
        await handlers.onMessage({ kind: 'text', text: 'b-1' }, 'android-b');
        await handlers.onMessage({ kind: 'text', text: 'c-1' }, 'android-c');
        await handlers.onMessage({ kind: 'text', text: 'a-2' }, 'android-a');
        assert.equal(requests.at(-1), '', '被淘汰的设备重新连接时不应带回旧上下文');
    });

    test('运行时 reset 同时清理宿主侧 DSH 连续上下文', async () => {
        let now = 60_000;
        let answers = 0;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-reset-context', now);
        const handlers = createDshCompanionHandlers({
            advisor: { advise: async request => { answers++; return `${answers}:${request.recentTurns?.length ?? 0}`; } },
        });
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), handlers, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-reset-context-hello', 'nonce-reset-context-hello', new Date(now).toISOString()));
        const first = await runtime.handle({ v: 1, requestId: 'req-reset-context-1', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-reset-context-1', body: { kind: 'text', text: '第一句' } });
        assert.equal(first.accepted && first.response?.body && (first.response.body as { text?: string }).text, '1:0');
        runtime.reset();
        now += 1;
        const replacement = pairing.issue('android-reset-context', now);
        await runtime.handle(helloEnvelope({ clientId: replacement.clientId, pairingCode: replacement.pairingCode, capabilities: ['text'] }, 'req-reset-context-hello-2', 'nonce-reset-context-hello-2', new Date(now).toISOString()));
        const second = await runtime.handle({ v: 1, requestId: 'req-reset-context-2', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-reset-context-2', body: { kind: 'text', text: '重新开始' } });
        assert.equal(second.accepted && second.response?.body && (second.response.body as { text?: string }).text, '2:0');
    });

    test('reset 后旧请求完成不会误减新配对的队列计数', async () => {
        let now = 65_000;
        let releaseOld!: () => void;
        let calls = 0;
        const oldPending = new Promise<void>(resolve => { releaseOld = resolve; });
        const pairing = new MemoryPairingStore(60_000);
        const first = pairing.issue('android-reset-queue', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => {
                calls++;
                if (calls === 1) await oldPending;
                return message;
            },
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: first.clientId, pairingCode: first.pairingCode, capabilities: ['text'] }, 'req-queue-hello-1', 'nonce-queue-hello-1', new Date(now).toISOString()));
        const oldRequest = runtime.handle({ v: 1, requestId: 'req-queue-old', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-queue-old', body: { kind: 'text', text: '旧请求' } });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(runtime.status().queued, 1);
        runtime.reset();
        assert.equal(runtime.status().queued, 0);
        now += 1;
        const second = pairing.issue('android-reset-queue', now);
        await runtime.handle(helloEnvelope({ clientId: second.clientId, pairingCode: second.pairingCode, capabilities: ['text'] }, 'req-queue-hello-2', 'nonce-queue-hello-2', new Date(now).toISOString()));
        const newRequest = await runtime.handle({ v: 1, requestId: 'req-queue-new', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-queue-new', body: { kind: 'text', text: '新请求' } });
        assert.equal(newRequest.accepted, true);
        assert.equal(runtime.status().queued, 0);
        releaseOld();
        await oldRequest;
        assert.equal(runtime.status().queued, 0);
    });

    test('reset 后尚未开始的旧会话请求不会进入宿主处理器', async () => {
        const now = 66_000;
        let releaseFirst!: () => void;
        const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
        const handled: string[] = [];
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-reset-pending', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => {
                handled.push(message.text ?? '');
                if (handled.length === 1) await firstPending;
                return message;
            },
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: true, decision: 'auto' }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-reset-pending-hello', 'nonce-reset-pending-hello', new Date(now).toISOString()));
        const first = runtime.handle({ v: 1, requestId: 'req-reset-pending-1', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-reset-pending-1', body: { kind: 'text', text: '已经开始' } });
        await new Promise(resolve => setTimeout(resolve, 0));
        const waiting = runtime.handle({ v: 1, requestId: 'req-reset-pending-2', kind: 'message.send', sentAt: new Date(now).toISOString(), nonce: 'nonce-reset-pending-2', body: { kind: 'text', text: '不应开始' } });
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(runtime.status().queued, 2);

        runtime.reset();
        releaseFirst();
        assert.equal((await first).accepted, true, '已经进入宿主的请求只能自然结束');
        assert.deepEqual(await waiting, { accepted: false, error: '设备配对已失效，请重新配对' });
        assert.deepEqual(handled, ['已经开始']);
        assert.equal(runtime.status().queued, 0);
    });

    test('模型等待期间撤销配对不会把旧请求写回新的 DSH 上下文', async () => {
        let release!: (value: string) => void;
        const pending = new Promise<string>(resolve => { release = resolve; });
        const calls: Array<readonly { role: string; content: string }[] | undefined> = [];
        const handlers = createDshCompanionHandlers({
            advisor: { advise: async request => { calls.push(request.recentTurns); return calls.length === 1 ? pending : '新设备回答'; } },
        });
        const oldRequest = handlers.onMessage({ kind: 'text', text: '撤销前的问题' }, 'android-race');
        handlers.onReset?.();
        release('旧设备不应收到的回答');
        assert.deepEqual(await oldRequest, { kind: 'text', text: '这台设备的配对已失效，请重新配对。' });
        await handlers.onMessage({ kind: 'text', text: '重新配对后的问题' }, 'android-race');
        assert.equal(calls.length, 2);
        assert.equal(calls[1], undefined);
    });

    test('DSH 伴侣自定义动作策略能拿到原始 requestId', async () => {
        let seen: string | undefined;
        const handlers = createDshCompanionHandlers({
            advisor: { advise: async () => '好' },
            onAction: async (_request, _clientId, requestId) => {
                seen = requestId;
                return { requestId, ok: true, decision: 'auto' };
            },
        });
        const result = await handlers.onAction({ action: 'notify', params: { text: 'x' }, decision: 'auto' }, 'android-policy', 'action-original');
        assert.equal(seen, 'action-original');
        assert.deepEqual(result, { requestId: 'action-original', ok: true, decision: 'auto' });
    });

    test('DSH 伴侣适配器可把安全的媒体摘要交给宿主', async () => {
        let seenMedia: CompanionMessage | undefined;
        const requests: Array<{ question: string; media?: { mediaId?: string; mime: string } }> = [];
        const handlers = createDshCompanionHandlers({
            advisor: { advise: async request => { requests.push({ question: request.question, media: request.media && { mediaId: request.media.mediaId, mime: request.media.mime } }); return '收到啦'; } },
            describeMedia: async (message, clientId) => { seenMedia = message; return `设备 ${clientId} 发来一张图片`; },
        });
        const message: CompanionMessage = { kind: 'image', media: { mediaId: 'abcdef0123456789', mime: 'image/png', bytes: 12, width: 32, height: 24 } };
        const reply = await handlers.onMessage(message, 'android-media');
        assert.equal(reply.text, '收到啦');
        assert.equal(seenMedia, message);
        assert.deepEqual(requests, [{ question: '设备 android-media 发来一张图片', media: { mediaId: 'abcdef0123456789', mime: 'image/png' } }]);
    });

    test('宿主可下发白名单动作，手机回执交给宿主审计', async () => {
        let now = 45_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-downlink', now);
        let actionResult: ActionResult | undefined;
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onActionResult: async result => { actionResult = result; },
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-downlink-hello', 'nonce-downlink-hello', new Date(now).toISOString()));
        const pushed = runtime.requestPhoneAction('android-downlink', { action: 'ring', params: { durationMs: 1000 }, decision: 'confirm' }, 'push-downlink-1');
        assert.equal(pushed.kind, 'action.request');
        assert.deepEqual(runtime.takeDownlinks('android-downlink'), [pushed]);
        const result = await runtime.handle({ v: 1, requestId: 'req-downlink-result', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-downlink-result', body: { requestId: 'push-downlink-1', ok: true, decision: 'confirm' } });
        assert.deepEqual(result, { accepted: true });
        assert.deepEqual(actionResult, { requestId: 'push-downlink-1', ok: true, decision: 'confirm' });
        const stale = runtime.requestPhoneAction('android-downlink', { action: 'notify', params: { text: '不应残留' }, decision: 'auto' }, 'push-downlink-stale');
        assert.equal(stale.body.action, 'notify');
        now += DOWNLINK_ACTION_TTL_MS + 1;
        assert.deepEqual(runtime.takeDownlinks('android-downlink'), []);
        const expiredResult = await runtime.handle({ v: 1, requestId: 'req-downlink-expired', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-downlink-expired', body: { requestId: 'push-downlink-stale', ok: true, decision: 'auto' } });
        if (expiredResult.accepted) assert.match(String(expiredResult.response?.body && (expiredResult.response.body as { message?: string }).message), /没有对应/);
        runtime.reset();
        assert.deepEqual(runtime.takeDownlinks('android-downlink'), []);
    });

    test('手机回执必须沿用下发动作的确认策略，不能把需确认动作伪报成自动执行', async () => {
        const now = 47_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-receipt-policy', now);
        const audited: ActionResult[] = [];
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onActionResult: async result => { audited.push(result); },
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-policy-hello', 'nonce-policy-hello', new Date(now).toISOString()));
        runtime.requestPhoneAction(ticket.clientId, { action: 'ring', params: { durationMs: 500 }, decision: 'confirm' }, 'push-policy-action');

        const downgraded = await runtime.handle({ v: 1, requestId: 'req-policy-auto', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-policy-auto', body: { requestId: 'push-policy-action', ok: true, decision: 'auto' } });
        if (downgraded.accepted) assert.match(String((downgraded.response?.body as { message?: string } | undefined)?.message), /确认级别/);
        assert.deepEqual(audited, [], '不可信回执不能进入宿主审计');

        const confirmed = await runtime.handle({ v: 1, requestId: 'req-policy-confirm', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-policy-confirm', body: { requestId: 'push-policy-action', ok: true, decision: 'confirm' } });
        assert.deepEqual(confirmed, { accepted: true });
        assert.deepEqual(audited, [{ requestId: 'push-policy-action', ok: true, decision: 'confirm' }]);
    });

    test('宿主审计临时失败时保留动作回执，重试成功后才消费', async () => {
        const now = 45_500;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-receipt-retry', now);
        let attempts = 0;
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onActionResult: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('audit temporarily unavailable');
            },
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-retry-hello', 'nonce-retry-hello', new Date(now).toISOString()));
        runtime.requestPhoneAction(ticket.clientId, { action: 'notify', params: { text: '完成了' }, decision: 'auto' }, 'push-receipt-retry');
        runtime.takeDownlinks(ticket.clientId);
        const body = { requestId: 'push-receipt-retry', ok: true, decision: 'auto' as const };
        const first = await runtime.handle({ v: 1, requestId: 'req-receipt-first', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-receipt-first', body });
        if (first.accepted) assert.equal(first.response?.kind, 'error');
        const retry = await runtime.handle({ v: 1, requestId: 'req-receipt-second', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-receipt-second', body });
        assert.deepEqual(retry, { accepted: true });
        assert.equal(attempts, 2);
        const duplicate = await runtime.handle({ v: 1, requestId: 'req-receipt-third', kind: 'action.result', sentAt: new Date(now).toISOString(), nonce: 'nonce-receipt-third', body });
        if (duplicate.accepted) assert.match(String((duplicate.response?.body as { message?: string } | undefined)?.message), /没有对应/);
        assert.equal(attempts, 2, '成功消费后不重复写审计');
    });

    test('宿主下行动作拒绝重复 requestId，避免回执槽位歧义', () => {
        let now = 46_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-duplicate', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onActionResult: async () => undefined,
        }, () => now);
        assert.equal(gateway.accept(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-duplicate-hello', 'nonce-duplicate-hello', new Date(now).toISOString()), 'session-duplicate').ok, true);
        const request = { action: 'notify' as const, params: { text: '测试' }, decision: 'auto' as const };
        runtime.requestPhoneAction('android-duplicate', request, 'push-duplicate');
        assert.throws(() => runtime.requestPhoneAction('android-duplicate', request, 'push-duplicate'), /requestId 已存在/);
    });

    test('宿主限制未回执下行动作，并在过期后释放容量', async () => {
        let now = 50_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-pending-limit', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-pending-hello', 'nonce-pending-hello', new Date(now).toISOString()));
        const request = { action: 'notify' as const, params: { text: '测试' }, decision: 'auto' as const };
        for (let index = 0; index < MAX_DOWNLINK_ACTIONS; index += 1) {
            runtime.requestPhoneAction(ticket.clientId, request, `push-pending-${index}`);
            assert.equal(runtime.takeDownlinks(ticket.clientId).length, 1);
        }
        assert.throws(() => runtime.requestPhoneAction(ticket.clientId, request, 'push-pending-overflow'), /等待回执过多/);
        now += DOWNLINK_ACTION_TTL_MS;
        assert.doesNotThrow(() => runtime.requestPhoneAction(ticket.clientId, request, 'push-pending-after-expiry'));
    });

    test('系统时钟明显回拨后丢弃待发送动作和回执凭据', async () => {
        let now = 1_000_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-downlink-clock', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: false, decision: 'deny' }),
            onActionResult: async () => undefined,
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-downlink-clock-hello', 'nonce-downlink-clock-hello', new Date(now).toISOString()));
        runtime.requestPhoneAction(ticket.clientId, { action: 'notify', params: { text: '不应延迟执行' }, decision: 'auto' }, 'push-downlink-clock');
        now -= MAX_CLOCK_SKEW_MS + 1;
        assert.deepEqual(runtime.takeDownlinks(ticket.clientId), []);
        assert.doesNotThrow(() => runtime.requestPhoneAction(ticket.clientId, { action: 'notify', params: { text: '容量已释放' }, decision: 'auto' }, 'push-downlink-clock-next'));
    });

    test('下行监听器抛错不影响动作入队，避免调用方误重试', async () => {
        const pairing = new MemoryPairingStore(60_000);
        const now = 70_000;
        const ticket = pairing.issue('android-listener', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async message => message,
            onAction: async (request, _clientId, requestId) => ({ requestId, ok: true, decision: request.decision }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-listener-hello', 'nonce-listener-hello', new Date(now).toISOString()));
        const unsubscribe = runtime.subscribeDownlinks(() => { throw new Error('传输已断开'); });
        assert.doesNotThrow(() => runtime.requestPhoneAction('android-listener', { action: 'notify', params: { text: 'hi' }, decision: 'auto' }, 'push-listener-action'));
        assert.equal(runtime.takeDownlinks('android-listener').length, 1);
        unsubscribe();
    });

    test('同一设备的并发消息按到达顺序串行进入宿主', async () => {
        let now = 60_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-serial', now);
        const gateway = new CompanionGateway(pairing, () => now);
        const seen: string[] = [];
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => {
                seen.push(message.text ?? '');
                if (message.text === '第一条') await new Promise(resolve => setTimeout(resolve, 20));
                return { kind: 'text', text: message.text ?? '' };
            },
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: true, decision: 'auto' }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-serial-hello', 'nonce-serial-hello', new Date(now).toISOString()));
        const first = { v: 1 as const, requestId: 'req-serial-1', kind: 'message.send' as const, sentAt: new Date(now).toISOString(), nonce: 'nonce-serial-1', body: { kind: 'text' as const, text: '第一条' } };
        const second = { v: 1 as const, requestId: 'req-serial-2', kind: 'message.send' as const, sentAt: new Date(now).toISOString(), nonce: 'nonce-serial-2', body: { kind: 'text' as const, text: '第二条' } };
        await Promise.all([runtime.handle(first), runtime.handle(second)]);
        assert.deepEqual(seen, ['第一条', '第二条']);
    });

    test('同一设备的待处理队列有上限，超限请求不占内存', async () => {
        let now = 70_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-limit', now);
        const gateway = new CompanionGateway(pairing, () => now);
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let first = true;
        const runtime = new CompanionRuntime(gateway, {
            onMessage: async message => {
                if (first) { first = false; await blocked; }
                return { kind: 'text', text: message.text ?? '' };
            },
            onAction: async (_request, _clientId, requestId) => ({ requestId, ok: true, decision: 'auto' }),
        }, () => now);
        await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-limit-hello', 'nonce-limit-hello', new Date(now).toISOString()));
        assert.deepEqual(runtime.status(), { pairedClientId: 'android-limit', connected: true, queued: 0, maxQueuedPerClient: 32 });
        const requests = Array.from({ length: 33 }, (_, index) => ({ v: 1 as const, requestId: `req-limit-${index.toString().padStart(2, '0')}`, kind: 'message.send' as const, sentAt: new Date(now).toISOString(), nonce: `nonce-limit-${index.toString().padStart(2, '0')}`, body: { kind: 'text' as const, text: `队列${index}` } }));
        const results = requests.map(request => runtime.handle(request));
        await new Promise(resolve => setTimeout(resolve, 0));
        release();
        const settled = await Promise.all(results);
        assert.equal(settled.filter(result => !result.accepted).length, 1);
        assert.equal(runtime.status().queued, 0);
        const retry = await runtime.handle(requests.at(-1)!);
        assert.equal(retry.accepted, true);
    });
});
