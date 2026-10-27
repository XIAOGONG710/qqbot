// node src/ops/continuity-cli.ts identity status | check | verify | note "<说明>"
// node src/ops/continuity-cli.ts memory summary | verify | tail [N] | note "<说明>"
// 设定账本和记忆账本（ADR 0157 / 0158）的命令行：看、验、手动补一条说明。可选 --data-dir D（默认 runtime/bot）、--repo R（默认当前仓库）。
// 账本只追加；这里没有删除或改写的入口。账本验不过时，修之前先留着原文件，再让我看。

import { resolve } from 'node:path';
import { Identity } from '../memory/identity.ts';
import { memoryLedger, recordNote, summarize } from '../memory/memory-audit.ts';

const args = process.argv.slice(2);
const flagValue = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = process.env.INIT_CWD ?? process.cwd();
const dataDir = resolve(base, flagValue('--data-dir') ?? 'runtime/bot');
const repoRoot = resolve(base, flagValue('--repo') ?? '.');
const [area, command, ...rest] = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--data-dir' && args[i - 1] !== '--repo');

if (area === 'identity') {
    const identity = new Identity({ repoRoot, dataDir, log: m => console.log(m) });
    if (command === 'status') console.log(identity.status());
    else if (command === 'check') {
        const report = identity.check();
        console.log(report.first ? '第一次建账。' : report.changes.length ? `发现 ${report.changes.length} 处设定改动${report.unexplained.length ? `，其中 ${report.unexplained.length} 处没有登记原因` : '，都有提交说明'}。` : '设定和上次一样。');
        console.log(identity.status());
        if (!report.chain.ok) process.exitCode = 1;
    } else if (command === 'verify') {
        const result = identity.ledger.verify();
        console.log(result.ok ? `设定账本验过了（${result.count} 条）。` : `设定账本验不过：${result.reason}（从第 ${result.brokenAt} 条起）`);
        if (!result.ok) process.exitCode = 1;
    } else if (command === 'note' && rest[0]) {
        identity.ledger.append('note', { by: 'cli', text: rest.join(' ').slice(0, 400) });
        console.log('已补一条说明。');
    } else usage();
} else if (area === 'memory') {
    const ledger = memoryLedger(dataDir);
    if (command === 'summary') console.log(summarize(ledger));
    else if (command === 'verify') {
        const result = ledger.verify();
        console.log(result.ok ? `记忆账本验过了（${result.count} 条）。` : `记忆账本验不过：${result.reason}（从第 ${result.brokenAt} 条起）`);
        if (!result.ok) process.exitCode = 1;
    } else if (command === 'tail') {
        const n = Number(rest[0] ?? 10) || 10;
        for (const entry of ledger.read().slice(-n)) console.log(`${entry.seq} ${entry.at.slice(0, 19).replace('T', ' ')} ${entry.kind} ${JSON.stringify(entry.data).slice(0, 140)}`);
    } else if (command === 'note' && rest[0]) {
        recordNote(ledger, rest.join(' '), 'cli');
        console.log('已补一条说明。');
    } else usage();
} else usage();

function usage(): void {
    console.error('用法：\n  continuity-cli.ts identity status | check | verify | note "<说明>"\n  continuity-cli.ts memory summary | verify | tail [N] | note "<说明>"');
    process.exitCode = 2;
}
