import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionAppModel } from '../src/model.ts';
import { registeredLinkTargets, resolveRegisteredLink } from '../action-links.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('伴侣 UI 状态层构造文字、媒体、表情和受限动作', () => {
    let nonce = 0;
    const app = new CompanionAppModel({ clientId: 'android-pwa', pairingCode: 'ABCD-1234', now: () => 10_000, nonce: () => `pwa-${String(++nonce).padStart(6, '0')}` });
    assert.equal(app.hello().kind, 'hello');
    assert.equal(app.text('你好').body.text, '你好');
    assert.equal(app.media('audio', { mediaId: 'a'.repeat(16), mime: 'audio/ogg', bytes: 10 }).body.kind, 'audio');
    assert.equal(app.media('image', { url: 'https://cdn.example/image.jpg', mime: 'image/jpeg', bytes: 100 }).body.kind, 'image');
    assert.equal(app.sticker('b'.repeat(16), { mediaId: 'c'.repeat(16), mime: 'image/webp', bytes: 100 }).body.kind, 'sticker');
    assert.equal(app.action('ring', {}).needsConfirmation, true);
    assert.equal(app.action('notify', {}).needsConfirmation, false);
    assert.equal(app.action('open_link', {}, '', 'companion-home').request.body.targetId, 'companion-home');
    const downlink = app.acceptDownlink({ v: 1, requestId: 'push-model-action', kind: 'action.request', sentAt: new Date(10_000).toISOString(), nonce: 'server-model-action', body: { action: 'ring', params: { durationMs: 200 }, decision: 'confirm' } });
    assert.equal(downlink.body.action, 'ring');
    assert.equal(app.conversation.length, 4);
});

test('伴侣 UI 状态层只接受对应的服务端响应，并可清空本地会话', () => {
    let nonce = 0;
    const app = new CompanionAppModel({ clientId: 'android-pwa', pairingCode: 'ABCD-1234', now: () => 20_000, nonce: () => `pwa-${String(++nonce).padStart(6, '0')}` });
    const request = app.text('在吗');
    const response = app.accept({ v: 1, requestId: `resp-${request.requestId}`, kind: 'message.receive', sentAt: new Date(20_000).toISOString(), nonce: 'server-pwa', body: { kind: 'text', text: '在呢' } });
    assert.equal(response.kind, 'message.receive');
    assert.equal(app.conversation.at(-1)?.direction, 'in');
    app.reset();
    assert.equal(app.conversation.length, 0);
    assert.equal(app.client.pendingCount, 0);
});

test('Service Worker 只缓存明确的静态资源，不拦截动作轮询等同源 GET', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'sw.js'), 'utf8');
    assert.match(source, /STATIC_URLS\s*=\s*new Set/);
    assert.match(source, /!STATIC_URLS\.has\(url\.href\)/);
    assert.match(source, /动作轮询、Koishi API/);
});

test('PWA 下行动作先做本地 nonce 防重放，再交给执行层', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'app.js'), 'utf8');
    assert.match(source, /receivedDownlinkNonces:\s*new Set/);
    assert.match(source, /function acceptDownlink\(value\)/);
    assert.match(source, /手机动作下行包重复/);
    assert.match(source, /敏感手机动作不能自动执行/);
    assert.match(source, /action\.decision === 'deny'/);
    assert.match(source, /resolveRegisteredLink\(action\.targetId/);
    assert.doesNotMatch(source, /action\.params\.url/);
    assert.match(source, /handleDownlink\(acceptDownlink\(value\)\)/);
});

test('PWA 打开链接只解析本地登记的目标，并拒绝普通局域网 HTTP', () => {
    assert.deepEqual(registeredLinkTargets('https://companion.example/app/index.html'), {
        'companion-home': 'https://companion.example/app/',
    });
    assert.equal(resolveRegisteredLink('companion-home', 'http://127.0.0.1:5140/companion/index.html'), 'http://127.0.0.1:5140/companion/');
    assert.throws(() => resolveRegisteredLink('not-registered', 'https://companion.example/app/'), /未在手机端登记/);
    assert.throws(() => resolveRegisteredLink('companion-home', 'http://192.168.1.8/app/'), /未在手机端登记/);
});

test('HTTPS 配对成功只由连接流程展示一次，登记链接请求携带 targetId', async () => {
    const source = await readFile(resolve(import.meta.dirname, '..', 'app.js'), 'utf8');
    assert.equal(source.match(/HTTPS 配对成功/g)?.length, 1);
    assert.match(source, /action === 'open_link' \? 'companion-home' : undefined/);
});
