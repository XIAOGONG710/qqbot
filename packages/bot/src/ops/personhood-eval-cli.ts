import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluatePersonhood, validPersonhoodEvalRow, type PersonhoodEvalRow } from './personhood-eval.ts';

const args = process.argv.slice(2);
const files = args.flatMap((arg, index) => arg === '--input' && args[index + 1] ? [resolve(args[index + 1]!)] : []);
if (!files.length) {
    console.error('用法：npm --workspace @qqbot/bot run eval:personhood -- --input <观察.jsonl> [--input ...] [--fail]');
    process.exit(2);
}
const rows: PersonhoodEvalRow[] = [];
for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
            const value: unknown = JSON.parse(line);
            if (validPersonhoodEvalRow(value)) rows.push(value);
        } catch { /* 损坏行不回显，继续统计其他行。 */ }
    }
}
const report = evaluatePersonhood(rows);
console.log(JSON.stringify(report, null, 2));
if (args.includes('--fail') && !report.passed) process.exitCode = 1;
