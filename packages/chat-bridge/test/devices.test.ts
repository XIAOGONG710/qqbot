import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_DEVICES, PAIRING_TTL_MS, createDeviceStore, fileDeviceStorage, memoryDeviceStorage } from '../src/devices.ts';
import { tempDir } from './helpers.ts';

function setup() {
    const storage = memoryDeviceStorage();
    let time = 1_000_000;
    const store = createDeviceStore({ storage, now: () => time });
    return { storage, store, advance(ms: number) { time += ms; } };
}

const wrongCode = (code: string) => code === '00000000' ? '00000001' : '00000000';

test('配对码是 8 位数字；配对后拿到设备 id 和 32 字节的 token', () => {
    const { store } = setup();
    const code = store.startPairing();
    assert.match(code, /^\d{8}$/);
    const result = store.pair(code, '  测试手机\n');
    assert.ok(result.ok);
    assert.equal(Buffer.from(result.token, 'base64url').length, 32);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.deviceId.includes('.'), false);
    assert.equal(store.verify(result.deviceId, result.token), true);
    assert.deepEqual(store.list().map(device => device.name), ['测试手机']);
});

test('表里只有 SHA-256，没有 token 和配对码原文', () => {
    const { store, storage } = setup();
    const code = store.startPairing();
    assert.equal(storage.read()!.includes(code), false);
    const result = store.pair(code, '手机');
    assert.ok(result.ok);
    const text = storage.read()!;
    assert.equal(text.includes(result.token), false);
    assert.ok(text.includes(createHash('sha256').update(result.token).digest('hex')));
});

test('配对码用过即废', () => {
    const { store } = setup();
    const code = store.startPairing();
    assert.ok(store.pair(code, 'a').ok);
    assert.deepEqual(store.pair(code, 'b'), { ok: false, reason: 'none' });
    assert.equal(store.list().length, 1);
});

test('配对码 10 分钟过期', () => {
    const { store, advance } = setup();
    const code = store.startPairing();
    advance(PAIRING_TTL_MS - 1);
    const fresh = setup();
    const freshCode = fresh.store.startPairing();
    fresh.advance(PAIRING_TTL_MS);
    assert.deepEqual(fresh.store.pair(freshCode, 'a'), { ok: false, reason: 'none' });
    assert.ok(store.pair(code, 'a').ok);
});

test('连错 5 次作废：第 6 次给对的也不行', () => {
    const { store } = setup();
    const code = store.startPairing();
    for (let attempt = 0; attempt < 4; attempt++) assert.deepEqual(store.pair(wrongCode(code), 'x'), { ok: false, reason: 'wrong' });
    assert.deepEqual(store.pair(12345678, 'x'), { ok: false, reason: 'wrong' });
    assert.deepEqual(store.pair(code, 'x'), { ok: false, reason: 'none' });
    assert.equal(store.list().length, 0);
});

test('错 4 次以内，对的码还能用；新码让旧码作废', () => {
    const { store } = setup();
    const code = store.startPairing();
    for (let attempt = 0; attempt < 4; attempt++) store.pair(wrongCode(code), 'x');
    assert.ok(store.pair(code, 'x').ok);

    const old = store.startPairing();
    const next = store.startPairing();
    if (old !== next) assert.equal(store.pair(old, 'y').ok, false);
    assert.ok(store.pair(next, 'y').ok);
});

test('没有发过配对码时一律不行', () => {
    const { store } = setup();
    assert.deepEqual(store.pair('00000000', 'x'), { ok: false, reason: 'none' });
});

test('verify：错的 token、别的设备的 token、奇怪的输入都不过', () => {
    const { store } = setup();
    const a = store.pair(store.startPairing(), 'a');
    const b = store.pair(store.startPairing(), 'b');
    assert.ok(a.ok && b.ok);
    assert.equal(store.verify(a.deviceId, b.token), false);
    assert.equal(store.verify(a.deviceId, `${a.token}x`), false);
    assert.equal(store.verify('nobody', a.token), false);
    assert.equal(store.verify(a.deviceId, ''), false);
    assert.equal(store.verify(undefined, undefined), false);
    assert.equal(store.verify(a.deviceId, { toString: () => a.token }), false);
    assert.equal(store.verify(b.deviceId, b.token), true);
});

test('撤销后凭据失效，别的设备不受影响', () => {
    const { store } = setup();
    const a = store.pair(store.startPairing(), 'a');
    const b = store.pair(store.startPairing(), 'b');
    assert.ok(a.ok && b.ok);
    assert.equal(store.revoke(a.deviceId), true);
    assert.equal(store.revoke(a.deviceId), false);
    assert.equal(store.verify(a.deviceId, a.token), false);
    assert.equal(store.has(a.deviceId), false);
    assert.equal(store.verify(b.deviceId, b.token), true);
});

test('设备数有上限', () => {
    const { store } = setup();
    for (let index = 0; index < MAX_DEVICES; index++) assert.ok(store.pair(store.startPairing(), `d${index}`).ok);
    assert.deepEqual(store.pair(store.startPairing(), 'one more'), { ok: false, reason: 'full' });
});

test('另一个进程写的表马上看得到（每次操作都重新读文件）', t => {
    const path = join(tempDir(t), 'devices.json');
    const relay = createDeviceStore({ storage: fileDeviceStorage(path) });
    const cli = createDeviceStore({ storage: fileDeviceStorage(path) });
    const result = relay.pair(cli.startPairing(), '手机');
    assert.ok(result.ok);
    assert.equal(relay.verify(result.deviceId, result.token), true);
    assert.equal(cli.revoke(result.deviceId), true);
    assert.equal(relay.verify(result.deviceId, result.token), false);
});

test('表坏了就明说，不当成空表（否则会悄悄丢掉所有设备）', () => {
    const store = createDeviceStore({ storage: memoryDeviceStorage('{ not json') });
    assert.throws(() => store.list(), /devices\.json/);
});
