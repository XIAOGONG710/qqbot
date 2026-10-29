import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWorkMode, setWorkMode, takeWorkMarker } from '../src/platform/work-mode.ts';

test('工作模式默认聊天，切换后能读回，且按联系人分开', () => {
    const dir = mkdtempSync(join(tmpdir(), 'work-mode-'));
    assert.equal(readWorkMode(dir, 10001), 'chat');
    setWorkMode(dir, 10001, 'work');
    assert.equal(readWorkMode(dir, 10001), 'work');
    assert.equal(readWorkMode(dir, 10002), 'chat');
    setWorkMode(dir, 10001, 'chat');
    assert.equal(readWorkMode(dir, 10001), 'chat');
});

test('她自己写 <<用电脑>>：标记摘掉、要干活；没写就原样返回', () => {
    assert.deepEqual(takeWorkMarker('好，我去弄 <<用电脑>>'), { text: '好，我去弄', wanted: true });
    assert.deepEqual(takeWorkMarker('<<用电脑>>'), { text: '', wanted: true });
    assert.deepEqual(takeWorkMarker('在呢，咋了'), { text: '在呢，咋了', wanted: false });
});
