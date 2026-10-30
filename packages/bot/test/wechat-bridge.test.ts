import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateMessageEvent, routeAction, toWechatText } from '../src/platform/wechat-bridge.ts';

const base = { wxid: 'wxid_x', numericId: 12345, text: '在吗', at: 1793354400000, messageId: 7, self: { numericId: 999, name: '林梦瑶' } };

test('私聊事件是 OneBot 11 的形状，Koishi 的 onebot 适配器认', () => {
    const event = privateMessageEvent(base);
    assert.equal(event.post_type, 'message');
    assert.equal(event.message_type, 'private');
    assert.equal(event.user_id, 12345);
    assert.equal(event.self_id, 999);
    assert.deepEqual(event.message, [{ type: 'text', data: { text: '在吗' } }]);
});

test('她发出去：只取文字段（微信没有 QQ 小黄脸）', () => {
    assert.equal(toWechatText([{ type: 'text', data: { text: '嗯' } }, { type: 'face', data: { id: '8' } }]), '嗯');
    assert.equal(toWechatText([{ type: 'face', data: { id: '8' } }]), '');
});

test('发文字：认识的人才发，微信没连上就说没连上', async () => {
    let sent = '';
    const deps = { ready: () => true, wxidOf: (id: number) => (id === 12345 ? 'wxid_x' : undefined), sendText: async (wxid: string, text: string) => { sent = `${wxid}:${text}`; return 88; } };
    const ok = await routeAction('send_private_msg', { user_id: 12345, message: [{ type: 'text', data: { text: '在的' } }] }, deps);
    assert.equal(ok.status, 'ok');
    assert.equal(sent, 'wxid_x:在的');
    const unknown = await routeAction('send_private_msg', { user_id: 1, message: [] }, deps);
    assert.equal(unknown.status, 'failed');
    const down = await routeAction('send_private_msg', { user_id: 12345, message: [{ type: 'text', data: { text: 'x' } }] }, { ...deps, ready: () => false });
    assert.equal(down.status, 'not-ready');
});

test('图片、语音明确说不能发；不认识的动作不假装成功', async () => {
    const deps = { ready: () => true, wxidOf: () => undefined, sendText: async () => 1 };
    assert.deepEqual((await routeAction('can_send_image', {}, deps)).data, { yes: false });
    assert.deepEqual((await routeAction('can_send_record', {}, deps)).data, { yes: false });
    assert.equal((await routeAction('set_group_ban', {}, deps)).status, 'unknown');
});
