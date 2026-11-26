import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecord } from '../src/types.ts';

test('isRecord 认普通对象：空对象、中文字段、嵌套对象', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ 名字: '林梦瑶', 详情: { 城市: '苏州' } }), true);
    assert.equal(isRecord({ type: 'text', data: { text: '你好' } }), true);
    assert.equal(isRecord(Object.create(null)), true);
});

test('isRecord 拒绝 null、undefined 和数组', () => {
    assert.equal(isRecord(null), false);
    assert.equal(isRecord(undefined), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord([{ kind: 'text', text: '你好' }]), false);
    assert.equal(isRecord(Object.assign([], { extra: 1 })), false);
});

test('isRecord 拒绝字符串、数字、布尔等原始值与函数', () => {
    for (const value of ['你好', '', 0, 42, NaN, true, false, 1n, Symbol('s'), () => 1]) {
        assert.equal(isRecord(value), false, `${String(value)} 不是 record`);
    }
});

test('isRecord 是浅判断：Date / Map 这类非数组对象也返回 true', () => {
    assert.equal(isRecord(new Date(0)), true);
    assert.equal(isRecord(new Map()), true);
    assert.equal(isRecord(new Set()), true);
});
