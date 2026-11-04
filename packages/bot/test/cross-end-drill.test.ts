import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCrossEndDrill } from '../src/ops/cross-end-drill.ts';

test('QQ、DSH、手机和重启后的上下文总演练通过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cross-end-test-'));
    try {
        const report = await runCrossEndDrill(dir);
        assert.equal(report.passed, true);
        assert.equal(report.calls, 1);
        assert.equal(report.checks.length, 4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
