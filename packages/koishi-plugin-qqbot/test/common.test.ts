import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error 手写的控制台 ES 模块没有类型声明
import { clock, tierLabel } from '../client/format.js';

test('控制台公共格式化不会把未知档位和异常日期显示成代码串', () => {
    assert.equal(tierLabel('boyfriend'), '男朋友');
    assert.equal(tierLabel('future_internal_tier'), '未知关系');
    assert.equal(tierLabel(undefined), '未知关系');
    assert.equal(clock('not-a-date'), '时间未知');
    assert.equal(clock(undefined), '');
});
