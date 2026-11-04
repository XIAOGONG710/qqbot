import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCrossEndDrill } from './cross-end-drill.ts';

const dir = mkdtempSync(join(tmpdir(), 'qqbot-cross-end-'));
try {
    const report = await runCrossEndDrill(dir);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
} finally {
    rmSync(dir, { recursive: true, force: true });
}
