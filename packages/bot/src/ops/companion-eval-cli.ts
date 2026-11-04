import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareCompanionWindows, evaluateCompanion, type CompanionEvalRow } from './companion-eval.ts';

const args = process.argv.slice(2);
const paths = args.flatMap((arg, index) => arg === '--chat' && args[index + 1] ? [resolve(args[index + 1]!)] : []);
const baselinePaths = args.flatMap((arg, index) => arg === '--baseline-chat' && args[index + 1] ? [resolve(args[index + 1]!)] : []);
if (!paths.length) {
    console.error('用法：npm --workspace @qqbot/bot run eval:companion -- --chat <当前.jsonl> [--baseline-chat <基线.jsonl>] [--fail-on-regression]');
    process.exit(2);
}
const load = (files: readonly string[]): CompanionEvalRow[] => {
const rows: CompanionEvalRow[] = [];
for (const path of files) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
            const row = JSON.parse(line) as CompanionEvalRow;
            if ((row.role === 'user' || row.role === 'assistant') && typeof row.time === 'string' && typeof row.content === 'string') rows.push(row);
        } catch { /* 损坏行不回显，继续统计其余记录 */ }
    }
}
return rows;
};
const rows = load(paths);
if (baselinePaths.length) {
    const report = compareCompanionWindows(load(baselinePaths), rows);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed && args.includes('--fail-on-regression')) process.exitCode = 1;
} else console.log(JSON.stringify(evaluateCompanion(rows), null, 2));
