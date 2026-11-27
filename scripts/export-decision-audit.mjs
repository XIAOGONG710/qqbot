import { readFileSync } from 'node:fs';
import { exportDecisionAudit } from '../packages/bot/src/platform/decision-audit.ts';

if (process.argv.length !== 3) {
    console.error('用法：node scripts/export-decision-audit.mjs 审计文件.jsonl');
    process.exitCode = 2;
} else {
    try {
        process.stdout.write(`${JSON.stringify(exportDecisionAudit(readFileSync(process.argv[2], 'utf8')), null, 2)}\n`);
    } catch {
        console.error('读取审计文件失败。');
        process.exitCode = 1;
    }
}
