import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeInfo } from '../src/platform/runtime-info.ts';

test('运行版本只读启动脚本给的 Git 身份；缺失时明确 unknown', () => {
    const at = new Date('2026-10-13T12:00:00Z');
    assert.deepEqual(runtimeInfo({}, at), { commit: 'unknown', branch: 'unknown', dirty: null, startedAt: at.toISOString() });
    assert.deepEqual(runtimeInfo({ QQBOT_GIT_COMMIT: ' abc ', QQBOT_GIT_BRANCH: ' main ', QQBOT_GIT_DIRTY: 'true' }, at), {
        commit: 'abc', branch: 'main', dirty: true, startedAt: at.toISOString(),
    });
});
