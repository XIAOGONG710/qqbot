// NapCat 有几个动作把 QQ 内核的失败放在返回值的 result 里，外层照样 ok / retcode 0（10-20 实测：私聊表情回应 result 65011）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertKernelOk } from '../src/platform/onebot.ts';

describe('assertKernelOk：内核结果不是 0 就算失败', () => {
    test('没有 result 的返回值、null、undefined、非对象：照旧当成功（很多动作本来就回 null）', () => {
        for (const data of [null, undefined, {}, 'ok', 42, [], { message_id: 7 }, { tid: 'abc' }]) assert.doesNotThrow(() => assertKernelOk('x', data));
    });

    test('result 为 0（可带 errMsg: success）：成功', () => {
        assert.doesNotThrow(() => assertKernelOk('set_input_status', { result: 0, errMsg: 'success' }));
    });

    test('result 非 0：抛错，带动作名、result 和 QQ 的原话', () => {
        assert.throws(() => assertKernelOk('set_msg_emoji_like', { result: 65011, errMsg: '操作失败，请稍后再试哦' }), /set_msg_emoji_like 被 QQ 拒绝（result 65011：操作失败，请稍后再试哦）/);
        assert.throws(() => assertKernelOk('set_input_status', { result: 1 }), /set_input_status 被 QQ 拒绝（result 1）/);
    });

    test('result 不是数字（别的动作恰好有这个字段名）：不当成失败', () => {
        assert.doesNotThrow(() => assertKernelOk('x', { result: true }));
        assert.doesNotThrow(() => assertKernelOk('x', { result: '0' }));
    });
});
