import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPhonePublisher, phoneMessage } from '../src/platform/device-phone.ts';

describe('手机这一头：ntfy 推送（ADR 0148）', () => {
    test('只做通知、定时（延时发送）、找手机；别的动作做不了', () => {
        assert.deepEqual(phoneMessage({ action: 'notify', target: 'phone', params: { text: '喝水' } }), { title: '林梦瑶', message: '喝水', priority: 3 });
        assert.deepEqual(phoneMessage({ action: 'timer', target: 'phone', params: { seconds: 600, label: '泡面' } }), { title: '林梦瑶', message: '泡面（定时提醒）', priority: 4, delay: '600s', tags: ['alarm_clock'] });
        assert.equal(phoneMessage({ action: 'ring', target: 'phone', params: {} })!.priority, 5);
        for (const action of ['lock', 'sleep', 'media', 'volume', 'open_url', 'open_app', 'capture_screen', 'capture_camera']) assert.equal(phoneMessage({ action, target: 'phone', params: {} }), undefined, action);
    });

    test('发布：POST 到 ntfy 根地址，JSON 里带话题；有令牌就带 Bearer', async () => {
        const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
        const publish = createPhonePublisher({
            baseUrl: 'https://ntfy.example/', topic: 'topic-secret-123', token: 'tk_abc',
            request: async (url, init) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{}' }; },
        });
        assert.deepEqual(await publish({ action: 'notify', target: 'phone', params: { text: '早' } }), { ok: true });
        assert.equal(seen[0]!.url, 'https://ntfy.example');
        assert.equal(seen[0]!.headers.Authorization, 'Bearer tk_abc');
        assert.deepEqual(seen[0]!.body, { topic: 'topic-secret-123', title: '林梦瑶', message: '早', priority: 3 });
    });

    test('失败原样说清：服务返回错误码、网络错误、做不了的动作', async () => {
        const down = createPhonePublisher({ baseUrl: 'https://x', topic: 't', request: async () => ({ ok: false, status: 429, text: async () => '' }) });
        assert.deepEqual(await down({ action: 'notify', target: 'phone', params: { text: 'x' } }), { ok: false, error: '推送服务返回 429' });
        const broken = createPhonePublisher({ baseUrl: 'https://x', topic: 't', request: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
        assert.deepEqual(await broken({ action: 'ring', target: 'phone', params: {} }), { ok: false, error: 'getaddrinfo ENOTFOUND' });
        assert.deepEqual(await broken({ action: 'lock', target: 'phone', params: {} }), { ok: false, error: '手机这一头做不了这个' });
    });
});
