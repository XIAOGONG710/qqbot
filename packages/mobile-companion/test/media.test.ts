import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { createCompanionMediaHandler } from '../src/media-http.ts';
import { MemoryCompanionMediaStore } from '../src/media.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';

test('内存媒体仓库按 TTL、设备归属和大小上限工作', () => {
    let now = 1_000;
    let id = 0;
    const store = new MemoryCompanionMediaStore({ ttlMs: 10_000, maxItemsPerClient: 1, maxTotalBytes: 8, now: () => now, id: () => `${(++id).toString(16).padStart(16, '0')}` });
    const first = store.put({ clientId: 'android-a', mime: 'image/png', data: Buffer.from('1234'), bytes: 4 });
    assert.equal(store.get('android-a', first.mediaId)?.bytes, 4);
    const copied = store.get('android-a', first.mediaId)!;
    copied.data[0] = 0;
    assert.equal(store.get('android-a', first.mediaId)?.data.toString(), '1234');
    const second = store.put({ clientId: 'android-a', mime: 'audio/ogg', data: Buffer.from('5678'), bytes: 4 });
    assert.equal(store.get('android-a', first.mediaId), undefined);
    assert.equal(store.get('android-b', second.mediaId), undefined);
    assert.equal(store.get('android-a', second.mediaId)?.mime, 'audio/ogg');
    const other = store.put({ clientId: 'android-b', mime: 'image/png', data: Buffer.from('xx'), bytes: 2 });
    assert.throws(() => store.put({ clientId: 'bad id', mime: 'image/png', data: Buffer.from('x'), bytes: 1 }));
    assert.equal(store.clear('android-a'), 1);
    assert.equal(store.get('android-a', second.mediaId), undefined);
    assert.equal(store.get('android-b', other.mediaId)?.bytes, 2);
    now += 10_000;
    assert.equal(store.purge(), 1);
    assert.equal(store.get('android-b', other.mediaId), undefined);
});

test('每设备上限只淘汰该设备最旧媒体，不受其他设备的全局顺序影响', () => {
    let id = 100;
    const store = new MemoryCompanionMediaStore({
        maxItems: 10,
        maxItemsPerClient: 1,
        maxTotalBytes: 100,
        id: () => `${(++id).toString(16).padStart(16, '0')}`,
    });
    const other = store.put({ clientId: 'android-b', mime: 'image/png', data: Buffer.from('b'), bytes: 1, now: 1 });
    const first = store.put({ clientId: 'android-a', mime: 'image/png', data: Buffer.from('a1'), bytes: 2, now: 2 });
    const replacement = store.put({ clientId: 'android-a', mime: 'image/png', data: Buffer.from('a2'), bytes: 2, now: 3 });
    assert.equal(store.get('android-b', other.mediaId, 3)?.bytes, 1);
    assert.equal(store.get('android-a', first.mediaId, 3), undefined);
    assert.equal(store.get('android-a', replacement.mediaId, 3)?.data.toString(), 'a2');
});

test('媒体 HTTP 上传必须使用已配对 session，并返回短期 mediaId', async () => {
    let now = 10_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-upload', now);
    const gateway = new CompanionGateway(pairing, () => now, { sessionIdleTtlMs: 60_000 });
    const runtime = new CompanionRuntime(gateway, { onMessage: async message => message, onAction: async (request, _clientId, requestId) => ({ requestId, ok: false, decision: request.decision }) }, () => now);
    const session = 'session-upload';
    const hello = helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'image'] }, 'req-upload-hello', 'nonce-upload-hello', new Date(now).toISOString());
    assert.equal((await runtime.handle(hello, session)).accepted, true);
    const store = new MemoryCompanionMediaStore({ now: () => now, id: () => '0123456789abcdef' });
    const server = createServer(createCompanionMediaHandler(runtime, store));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    try {
        const missing = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-mime': 'image/png' }, body: Buffer.from('x') });
        assert.equal(missing.status, 401);
        const uploaded = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/png', 'x-companion-width': '32', 'x-companion-height': '24' }, body: Buffer.from('image-bytes') });
        assert.equal(uploaded.status, 201);
        const result = await uploaded.json() as { mediaId: string; bytes: number; width: number; height: number };
        assert.equal(result.mediaId, '0123456789abcdef');
        assert.equal(result.bytes, 11);
        assert.equal(result.width, 32);
        assert.equal(result.height, 24);
        assert.equal(store.get('android-upload', result.mediaId)?.data.toString(), 'image-bytes');
        const badMime = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'application/zip' }, body: Buffer.from('x') });
        assert.equal(badMime.status, 415);
        now += 60_001;
        const expired = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/png' }, body: Buffer.from('stale') });
        assert.equal(expired.status, 401);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
