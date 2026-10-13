// node src/ops/audit-gate-cli.ts [--update]：跑 `npm audit --json`，对照 docs/security/npm-audit-baseline.json。
// 退出码：0 通过；1 有 high / critical 或基线外的新公告；2 拿不到审计结果（不静默当作通过）。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisoriesOf, judgeAudit, type AuditBaseline, type AuditReport } from './audit-gate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const baselinePath = join(root, 'docs', 'security', 'npm-audit-baseline.json');
const run = spawnSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 });
let report: AuditReport;
try {
    report = JSON.parse(run.stdout) as AuditReport;
    if ((report as { error?: unknown }).error) throw new Error(JSON.stringify((report as { error: unknown }).error));
} catch (error) {
    console.error(`拿不到审计结果：${error instanceof Error ? error.message : String(error)}\n${run.stderr.slice(0, 500)}`);
    process.exit(2);
}

if (process.argv.includes('--update')) {
    const old = JSON.parse(readFileSync(baselinePath, 'utf8')) as AuditBaseline;
    const next: AuditBaseline = { ...old, advisories: advisoriesOf(report).map(item => item.id) };
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`基线已更新：${next.advisories.join(', ') || '(空)'}（改完请在 PR 里写明为什么这些可以放过）`);
    process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as AuditBaseline;
const verdict = judgeAudit(report, baseline);
const line = (item: { id: number; name: string; severity: string; title: string; url: string }) => `  - ${item.id} ${item.name} [${item.severity}] ${item.title}\n    ${item.url}`;
console.log(`已知并记录在基线里的公告 ${verdict.known.length} 个${verdict.gone.length ? `；基线里有 ${verdict.gone.length} 个已经不再出现（${verdict.gone.join(', ')}），可以 --update 清掉` : ''}`);
if (verdict.blocking.length) console.log(`high / critical：\n${verdict.blocking.map(line).join('\n')}`);
if (verdict.fresh.length) console.log(`基线之外的新公告：\n${verdict.fresh.map(line).join('\n')}`);
console.log(verdict.ok ? '依赖审计：通过' : '依赖审计：不通过');
process.exit(verdict.ok ? 0 : 1);
