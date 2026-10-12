import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { CRISIS_PAUSE_MS, createCrisisState } from '../src/crisis-state.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('危机信号记录（ADR 0068 决策 5、6）', () => {
    test('只记谁、什么时候；暂停 48 小时；重启后还在；不记内容', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-crisis-'));
        dirs.push(dir);
        const t0 = Date.UTC(2026, 9, 12, 14, 0, 0);
        const state = createCrisisState(dir, () => {});
        assert.equal(state.lastAt(10001), undefined);
        assert.equal(state.pausedAt(10001, t0), false);
        state.mark(10001, t0);
        assert.equal(state.pausedAt(10001, t0 + CRISIS_PAUSE_MS - 1), true);
        assert.equal(state.pausedAt(10001, t0 + CRISIS_PAUSE_MS), false);
        assert.equal(state.pausedAt(10002, t0), false, '别的联系人不受影响');
        // 更早的不覆盖更晚的
        state.mark(10001, t0 - 1000);
        assert.equal(state.lastAt(10001), t0);
        // 重启后还在；文件里只有 QQ 号和时间
        const again = createCrisisState(dir, () => {});
        assert.equal(again.lastAt(10001), t0);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'crisis.json'), 'utf8')), { '10001': new Date(t0).toISOString() });
    });
});
