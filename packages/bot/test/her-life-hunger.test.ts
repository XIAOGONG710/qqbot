import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error 这个脚本是 .mjs，没有类型声明；只测里面那个纯函数
import { hungerAfterActivity, HUNGER_AFTER_MEAL } from '../../../scripts/her-life.mjs';

// 2026-10-30 00:04 她说「饿得睡不着」：饥饿只涨不降，两天就卡在 100。去吃一顿就该饱。
test('去吃东西就饱，别的活动不动饥饿值', () => {
    assert.equal(hungerAfterActivity('找点吃的', 100), HUNGER_AFTER_MEAL);
    assert.ok(HUNGER_AFTER_MEAL < 20);
    assert.equal(hungerAfterActivity('睡觉', 100), 100);
    assert.equal(hungerAfterActivity('看书/追剧', 42), 42);
});
