import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { herPlanActivities, herPlanToday, saveHerPlan, validHerPlan, windowAt } from '../src/life/her-plans.ts';

// ADR 0182：她自己决定今天想干什么，写成这一天的额外空闲活动
describe('她自己决定的今天', () => {
    test('写了就进状态里的那一段；第二天不算数；窗口按钟点；坏数据不收', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-plan-'));
        try {
            const at = new Date(2026, 9, 30, 15, 0);
            saveHerPlan(dir, { date: '2026-10-30', window: windowAt(at), text: '去操场走两圈', at: at.toISOString() });
            assert.deepEqual(herPlanActivities(dir, at), [{ window: 'afternoon', text: '去操场走两圈' }]);
            assert.equal(herPlanToday(dir, at)?.text, '去操场走两圈');
            assert.deepEqual(herPlanActivities(dir, new Date(2026, 9, 31, 10)), [], '第二天不算数');
            assert.equal(windowAt(new Date(2026, 9, 30, 9)), 'morning');
            assert.equal(windowAt(new Date(2026, 9, 30, 20)), 'evening');
            assert.equal(validHerPlan({ date: '2026-10-30', window: 'noon', text: '走两圈', at: at.toISOString() }), false, '窗口不对');
            assert.equal(validHerPlan({ date: '2026-10-30', window: 'morning', text: '走', at: at.toISOString() }), false, '太短');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('文件坏了当没有，不抛', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-plan-'));
        try {
            assert.deepEqual(herPlanActivities(dir, new Date()), [], '没文件');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
