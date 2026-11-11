import assert from 'node:assert/strict';
import test from 'node:test';
import {
    authorization, encodeFrame, helloFrame, historyPath, isCredentials, mediaPath, parseHistory, parseMessage, parseServerFrame,
    pingFrame, pokeFrame, recallFrame, safeHttpsUrl, sendFrame, uploadMime, MAX_FRAME_BYTES,
} from '../src/protocol.js';

const credentials = { deviceId: 'dev-1', token: 'tok-abc' };

test('hello 是第一帧，带凭据和 since；凭据只出现在帧和 Authorization 里', () => {
    assert.deepEqual(helloFrame(credentials, 42), { type: 'hello', deviceId: 'dev-1', token: 'tok-abc', since: 42 });
    assert.deepEqual(helloFrame(credentials, -3), { type: 'hello', deviceId: 'dev-1', token: 'tok-abc', since: 0 });
    assert.equal(authorization(credentials), 'Bearer dev-1.tok-abc');
    assert.equal(historyPath(120, 50), '/api/history?before=120&limit=50');
    assert.equal(historyPath(120, 500), '/api/history?before=120&limit=100');
    assert.equal(mediaPath('abc_DEF-1.png'), '/api/media/abc_DEF-1.png');
    assert.throws(() => mediaPath('../secret'));
    assert.throws(() => mediaPath('a/b'));
});

test('手机发出的帧和 ADR 里的形状一致', () => {
    assert.deepEqual(sendFrame('c1', [{ kind: 'text', text: '在吗' }]), { type: 'send', clientId: 'c1', parts: [{ kind: 'text', text: '在吗' }] });
    assert.deepEqual(sendFrame('c1', [{ kind: 'text', text: '在吗' }], 123), { type: 'send', clientId: 'c1', parts: [{ kind: 'text', text: '在吗' }], replyTo: 123 });
    assert.deepEqual(recallFrame(123), { type: 'recall', id: 123 });
    assert.deepEqual(pokeFrame(), { type: 'poke' });
    assert.deepEqual(pingFrame(), { type: 'ping' });
    assert.equal(encodeFrame(pingFrame()), '{"type":"ping"}');
});

test('单帧超过 64 KiB（按 UTF-8 字节算）拒发', () => {
    const fits = sendFrame('c1', [{ kind: 'text', text: '好'.repeat(20_000) }]);
    assert.ok(encodeFrame(fits).length > 0);
    const tooBig = sendFrame('c1', [{ kind: 'text', text: '好'.repeat(22_000) }]);
    assert.ok(JSON.stringify(tooBig).length < MAX_FRAME_BYTES, '字符数没超，字节数超了');
    assert.throws(() => encodeFrame(tooBig), RangeError);
});

test('解析中继的每一种帧', () => {
    assert.deepEqual(parseServerFrame('{"type":"ready","seq":42,"self":{"name":"小满"},"upstream":"up"}'), { type: 'ready', seq: 42, self: { name: '小满' }, upstream: 'up' });
    assert.deepEqual(parseServerFrame({ type: 'event', seq: 43, event: { kind: 'recall', id: 123 } }), { type: 'event', seq: 43, event: { kind: 'recall', id: 123 } });
    assert.deepEqual(parseServerFrame({ type: 'event', seq: 43, event: { kind: 'read', upTo: 123 } }), { type: 'event', seq: 43, event: { kind: 'read', upTo: 123 } });
    assert.deepEqual(parseServerFrame({ type: 'event', seq: 43, event: { kind: 'reaction', id: 123, emojiId: 76 } }), { type: 'event', seq: 43, event: { kind: 'reaction', id: 123, emojiId: 76 } });
    assert.deepEqual(parseServerFrame({ type: 'ack', clientId: 'c1', id: 124, seq: 44 }), { type: 'ack', clientId: 'c1', id: 124, seq: 44 });
    assert.deepEqual(parseServerFrame({ type: 'typing', on: true }), { type: 'typing', on: true });
    assert.deepEqual(parseServerFrame({ type: 'upstream', state: 'down' }), { type: 'upstream', state: 'down' });
    assert.deepEqual(parseServerFrame('{"type":"pong"}'), { type: 'pong' });
    assert.deepEqual(parseServerFrame({ type: 'error', code: 'not_delivered', message: 'x', clientId: 'c1' }), { type: 'error', code: 'not_delivered', message: 'x', clientId: 'c1' });
});

test('坏帧一律丢掉，不抛', () => {
    for (const bad of ['', 'not json', '[]', 'null', '{"type":"message"}', '{"type":"event","seq":1,"event":{"kind":"nope"}}',
        '{"type":"ack","clientId":1,"id":1,"seq":1}', '{"type":"error","code":"weird"}', '{"type":"upstream","state":"maybe"}', '{"type":"other"}']) {
        assert.equal(parseServerFrame(bad), undefined, bad);
    }
    assert.equal(parseServerFrame(42), undefined);
});

test('消息：每种段都收，多余字段去掉，不认识的段变占位文字', () => {
    const message = parseMessage({
        seq: 7, id: 900, from: 'her', via: 'qq', at: 1_700_000_000_000, replyTo: 880, extra: 'x',
        parts: [
            { kind: 'text', text: '看', html: '<b>x</b>' },
            { kind: 'face', id: 14, name: '微笑' },
            { kind: 'image', mediaId: 'm1', mime: 'image/png', summary: '照片' },
            { kind: 'voice', mediaId: 'm2', mime: 'audio/ogg', durationMs: 3200 },
            { kind: 'card', title: '文章', url: 'https://example.com/a' },
            { kind: 'poke' },
            { kind: 'hologram' },
        ],
    });
    assert.deepEqual(message, {
        seq: 7, id: 900, from: 'her', via: 'qq', at: 1_700_000_000_000, replyTo: 880,
        parts: [
            { kind: 'text', text: '看' },
            { kind: 'face', id: 14, name: '微笑' },
            { kind: 'image', mediaId: 'm1', mime: 'image/png', summary: '照片' },
            { kind: 'voice', mediaId: 'm2', mime: 'audio/ogg', durationMs: 3200 },
            { kind: 'card', title: '文章', url: 'https://example.com/a' },
            { kind: 'poke' },
            { kind: 'text', text: '[暂不支持的消息]' },
        ],
    });
    assert.equal(parseMessage({ seq: 1, id: 1, from: 'someone', via: 'app', at: 1, parts: [] }), undefined);
    assert.equal(parseMessage({ seq: 1, id: 1, from: 'me', via: 'app', at: 1 }), undefined);
    assert.equal(parseMessage({ seq: 1, id: 1, from: 'me', via: 'app', at: 1, parts: [], recalled: true, clientId: 'c9' })?.recalled, true);
});

test('媒体编号里不许有路径字符', () => {
    const message = parseMessage({ seq: 1, id: 1, from: 'her', via: 'app', at: 1, parts: [{ kind: 'image', mediaId: '../../etc', mime: 'image/png' }] });
    assert.deepEqual(message?.parts, [{ kind: 'text', text: '[暂不支持的消息]' }]);
});

test('历史：消息按 seq 排好，事件两种写法都认', () => {
    const page = parseHistory({
        messages: [
            { seq: 5, id: 105, from: 'me', via: 'app', at: 5, parts: [] },
            { seq: 3, id: 103, from: 'her', via: 'app', at: 3, parts: [] },
            { broken: true },
        ],
        events: [{ seq: 6, event: { kind: 'recall', id: 103 } }, { seq: 4, kind: 'read', upTo: 105 }, { seq: 9, event: { kind: 'x' } }],
    });
    assert.deepEqual(page.messages.map(m => m.seq), [3, 5]);
    assert.deepEqual(page.events, [{ seq: 4, event: { kind: 'read', upTo: 105 } }, { seq: 6, event: { kind: 'recall', id: 103 } }]);
    assert.deepEqual(parseHistory(null), { messages: [], events: [] });
});

test('上传类型只认协议列出的那几种，去掉 codecs 参数', () => {
    assert.equal(uploadMime('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(uploadMime('image/jpg'), 'image/jpeg');
    assert.equal(uploadMime('IMAGE/PNG'), 'image/png');
    assert.equal(uploadMime('image/heic'), undefined);
    assert.equal(uploadMime('video/mp4'), undefined);
});

test('只有 https 链接可以点', () => {
    assert.equal(safeHttpsUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'intent://x', '//example.com', 'example.com', '', undefined, 42]) {
        assert.equal(safeHttpsUrl(bad), undefined, String(bad));
    }
});

test('凭据形状', () => {
    assert.equal(isCredentials(credentials), true);
    assert.equal(isCredentials({ deviceId: 'a' }), false);
    assert.equal(isCredentials({ deviceId: '', token: 't' }), false);
    assert.equal(isCredentials(null), false);
});
