import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPairRequest, defaultDeviceName, displayCode, normalizeCode, normalizeDeviceName, readPairResponse } from '../src/pairing.js';

test('配对码：只留数字，空格、横线、全角数字都能贴进来', () => {
    assert.equal(normalizeCode('1234 5678'), '12345678');
    assert.equal(normalizeCode('1234-5678\n'), '12345678');
    assert.equal(normalizeCode('１２３４５６７８'), '12345678');
    assert.equal(normalizeCode('123456789'), '12345678');
    assert.equal(displayCode('123456'), '1234 56');
    assert.equal(displayCode('12'), '12');
});

test('请求体：8 位数字 + 设备名，缺哪个指哪个', () => {
    assert.deepEqual(buildPairRequest('1234 5678', '  我的\t手机 '), { ok: true, body: { code: '12345678', deviceName: '我的 手机' } });
    assert.deepEqual(buildPairRequest('1234', '手机'), { ok: false, field: 'code', message: '配对码是 8 位数字' });
    assert.deepEqual(buildPairRequest('12345678', '  '), { ok: false, field: 'deviceName', message: '给这台设备起个名字' });
    assert.equal(normalizeDeviceName('名'.repeat(80)).length, 40);
});

test('默认设备名从 UA 里猜', () => {
    assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit/537.36'), 'Pixel 8');
    assert.equal(defaultDeviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36'), '我的手机');
    assert.equal(defaultDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), '我的电脑');
    assert.equal(defaultDeviceName(''), '我的设备');
});

test('配对结果：成功拿到凭据；各种失败各有说法', () => {
    assert.deepEqual(readPairResponse(200, { deviceId: 'dev-1', token: 'tok', extra: 1 }), { ok: true, credentials: { deviceId: 'dev-1', token: 'tok' } });
    const reason = (status: number, body?: unknown) => {
        const result = readPairResponse(status, body);
        return result.ok ? 'ok' : result.reason;
    };
    assert.equal(reason(200, { deviceId: 'dev-1' }), 'malformed');
    assert.equal(reason(403, { error: 'invalid_code' }), 'invalid');
    assert.equal(reason(401, { error: 'unauthorized', message: 'x' }), 'invalid');
    assert.equal(reason(403, { error: 'expired' }), 'expired');
    assert.equal(reason(410), 'expired');
    assert.equal(reason(403, { error: 'locked' }), 'locked');
    assert.equal(reason(429, { error: 'rate_limited' }), 'rate_limited');
    assert.equal(reason(502, '<html>'), 'server');
    const invalid = readPairResponse(403, {});
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.match(invalid.message, /配对码不对/);
});
