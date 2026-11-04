import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('发布清单声明备份、协议和状态迁移版本', () => {
    const root = resolve(import.meta.dirname, '..');
    const manifest = JSON.parse(readFileSync(resolve(root, 'release/manifest.json'), 'utf8'));
    assert.equal(manifest.requiresBackup, true);
    assert.equal(manifest.protocol, 1);
    assert.equal(manifest.androidVersionCode, 2);
    assert.ok(Object.keys(manifest.stateSchemas).length >= 3);
});
