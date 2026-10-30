import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rememberWechat, wechatId, type WechatDirectory } from '../src/platform/wechat-id.ts';

// 目标：她自己一个微信号去跟别人聊；现有 QQ 代码全按数字 id 走，微信 wxid 先映射成稳定数字
test('同一个 wxid 永远是同一个数字；大小写和空格不影响', () => {
    const a = wechatId('wxid_abc123');
    assert.equal(typeof a, 'number');
    assert.equal(wechatId('wxid_abc123'), a);
    assert.equal(wechatId(' WXID_ABC123 '), a);
    assert.notEqual(wechatId('wxid_other'), a);
});

test('空 id 不产生数字（不能给不存在的联系人建档案）', () => {
    assert.equal(wechatId(''), undefined);
    assert.equal(wechatId('   '), undefined);
});

test('数字在安全整数范围内，能写进聊天记录文件名', () => {
    const id = wechatId('wxid_philosophy_of_mind')!;
    assert.ok(Number.isSafeInteger(id) && id > 0);
    assert.ok(id < 2 ** 53);
});

test('映射表记下来能反查；同一个 wxid 重复记不冲突，被别的 wxid 占了要报冲突', () => {
    const dir: WechatDirectory = {};
    const first = rememberWechat(dir, 'wxid_a')!;
    assert.equal(first.conflict, false);
    assert.equal(dir[String(first.id)], 'wxid_a');
    assert.equal(rememberWechat(dir, 'wxid_a')!.conflict, false, '同一个号重复记不算冲突');
    // 手工塞一个假的冲突：把 wxid_a 的数字给别的号
    dir[String(first.id)] = 'wxid_b';
    assert.equal(rememberWechat(dir, 'wxid_a')!.conflict, true, '同一数字已经有主，必须报出来，不静默合并');
});
