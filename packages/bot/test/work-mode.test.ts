import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWorkMode, setWorkMode } from '../src/platform/work-mode.ts';

test('工作模式默认聊天，切换后能读回，且按联系人分开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-mode-'));
    assert.equal(readWorkMode(dir, 10001), 'chat');
    setWorkMode(dir, 10001, 'work');
    assert.equal(readWorkMode(dir, 10001), 'work');
    assert.equal(readWorkMode(dir, 10002), 'chat');
    setWorkMode(dir, 10001, 'chat');
    assert.equal(readWorkMode(dir, 10001), 'chat');
});
