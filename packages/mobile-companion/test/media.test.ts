import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { createCompanionMediaHandler } from '../src/media-http.ts';
import { MemoryCompanionMediaStore } from '../src/media.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { MAX_CLOCK_SKEW_MS } from '../src/protocol.ts';
import { CompanionRuntime } from '../src/runtime.ts';

const png = (tail = '') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const ogg = (tail = '') => Buffer.concat([Buffer.from('OggS'), Buffer.from(tail)]);

test('内存媒体仓库按 TTL、设备归属和大小上限工作', () => {
    let now = 1_000;
    let id = 0;
    const store = new MemoryCompanionMediaStore({ ttlMs: 10_000, maxItemsPerClient: 1, maxTotalBytes: 24, now: () => now, id: () => `${(++id).toString(16).padStart(16, '0')}` });
    const firstData = png('1234');
    const first = store.put({ clientId: 'android-a', mime: 'image/png', data: firstData, bytes: firstData.length });
    assert.equal(store.get('android-a', first.mediaId)?.bytes, firstData.length);
    const copied = store.get('android-a', first.mediaId)!;
    copied.data[0] = 0;
    assert.deepEqual(store.get('android-a', first.mediaId)?.data, firstData);
    const secondData = ogg('5678');
    const second = store.put({ clientId: 'android-a', mime: 'audio/ogg', data: secondData, bytes: secondData.length });
    assert.equal(store.get('android-a', first.mediaId), undefined);
    assert.equal(store.get('android-b', second.mediaId), undefined);
    assert.equal(store.get('android-a', second.mediaId)?.mime, 'audio/ogg');
    const otherData = png('xx');
    const other = store.put({ clientId: 'android-b', mime: 'image/png', data: otherData, bytes: otherData.length });
    assert.throws(() => store.put({ clientId: 'bad id', mime: 'image/png', data: png(), bytes: png().length }));
    assert.equal(store.clear('android-a'), 1);
    assert.equal(store.get('android-a', second.mediaId), undefined);
    assert.equal(store.get('android-b', other.mediaId)?.bytes, otherData.length);
    now += 10_000;
    assert.equal(store.purge(), 1);
    assert.equal(store.get('android-b', other.mediaId), undefined);
});

test('媒体仓库拒绝 SVG、未知音频和伪造的 PNG 内容', () => {
    const store = new MemoryCompanionMediaStore();
    assert.throws(() => store.put({ clientId: 'android-safe', mime: 'image/svg+xml', data: Buffer.from('<svg/>'), bytes: 6 }), /允许列表/);
    assert.throws(() => store.put({ clientId: 'android-safe', mime: 'audio/x-custom', data: Buffer.from('custom'), bytes: 6 }), /允许列表/);
    assert.throws(() => store.put({ clientId: 'android-safe', mime: 'image/png', data: Buffer.from('<svg/>'), bytes: 6 }), /声明类型不一致/);
});

test('每设备上限只淘汰该设备最旧媒体，不受其他设备的全局顺序影响', () => {
    let id = 100;
    const store = new MemoryCompanionMediaStore({
        maxItems: 10,
        maxItemsPerClient: 1,
        maxTotalBytes: 100,
        id: () => `${(++id).toString(16).padStart(16, '0')}`,
    });
    const otherData = png('b'); const firstData = png('a1'); const replacementData = png('a2');
    const other = store.put({ clientId: 'android-b', mime: 'image/png', data: otherData, bytes: otherData.length, now: 1 });
    const first = store.put({ clientId: 'android-a', mime: 'image/png', data: firstData, bytes: firstData.length, now: 2 });
    const replacement = store.put({ clientId: 'android-a', mime: 'image/png', data: replacementData, bytes: replacementData.length, now: 3 });
    assert.equal(store.get('android-b', other.mediaId, 3)?.bytes, otherData.length);
    assert.equal(store.get('android-a', first.mediaId, 3), undefined);
    assert.deepEqual(store.get('android-a', replacement.mediaId, 3)?.data, replacementData);
});

test('系统时钟明显回拨后清理短期媒体', () => {
    let now = 1_000_000;
    const store = new MemoryCompanionMediaStore({ now: () => now, id: () => 'fedcba9876543210' });
    const data = png('x');
    const record = store.put({ clientId: 'android-clock', mime: 'image/png', data, bytes: data.length });
    now -= MAX_CLOCK_SKEW_MS + 1;
    assert.equal(store.get('android-clock', record.mediaId), undefined);
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
        const uploadData = png('image-bytes');
        const uploaded = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/png', 'x-companion-width': '32', 'x-companion-height': '24' }, body: uploadData });
        assert.equal(uploaded.status, 201);
        const result = await uploaded.json() as { mediaId: string; bytes: number; width: number; height: number };
        assert.equal(result.mediaId, '0123456789abcdef');
        assert.equal(result.bytes, uploadData.length);
        assert.equal(result.width, 32);
        assert.equal(result.height, 24);
        assert.deepEqual(store.get('android-upload', result.mediaId)?.data, uploadData);
        const badMime = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'application/zip' }, body: Buffer.from('x') });
        assert.equal(badMime.status, 415);
        const svg = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/svg+xml' }, body: Buffer.from('<svg/>') });
        assert.equal(svg.status, 415);
        const fakePng = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/png' }, body: Buffer.from('<svg/>') });
        assert.equal(fakePng.status, 400);
        now += 60_001;
        const expired = await fetch(`${base}/companion/v1/media`, { method: 'POST', headers: { 'x-companion-session': session, 'x-companion-mime': 'image/png' }, body: Buffer.from('stale') });
        assert.equal(expired.status, 401);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
