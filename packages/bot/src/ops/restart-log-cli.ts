// 重启记录（任务书 T3a）：
//   npm run restart-log -w packages/bot -- --to <提交> --kind behavior|safety|recovery --reason "<为什么>" [--by claude] [--at <ISO，默认现在>] [--file <路径>]
//   npm run restart-log -w packages/bot -- --list [--file <路径>]
// 默认文件：线上目录的 runtime/bot/restarts.log（runtime/ 被忽略，不进仓库）。每次重启 / 上线做完就追加一行；上线前检查（golive-check）据此挡「不满 48 小时」。
// kind：behavior 会改变她的行为或多一个变量（计入 48 小时）；safety 修故障 / 安全；recovery 整机重启 / 崩溃后恢复，同一版代码。
import { resolve } from 'node:path';
import { appendRestart, behaviorGap, readRestartLog, RESTART_KINDS, type RestartKind } from './restart-log.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const file = resolve(option('--file') ?? resolve(import.meta.dirname, '../../../../runtime/bot/restarts.log'));

if (args.includes('--list')) {
    const entries = readRestartLog(file);
    if (!entries.length) console.log(`（${file} 里还没有记录）`);
    for (const entry of entries) console.log(`${entry.at}  ${entry.kind.padEnd(8)}  ${entry.to}  ${entry.by || '-'}  ${entry.reason}`);
    const gap = behaviorGap(entries, new Date());
    if (gap.last && gap.sinceMs !== undefined) console.log(`\n距上一次行为变化的重启 ${Math.floor(gap.sinceMs / 3_600_000)} 小时：${gap.ok ? '已满 48 小时' : '不满 48 小时'}`);
    process.exit(0);
}

const kind = option('--kind') as RestartKind | undefined;
if (!kind || !(RESTART_KINDS as readonly string[]).includes(kind)) {
    console.error(`--kind 要是 ${RESTART_KINDS.join(' / ')}`);
    process.exit(2);
}
try {
    appendRestart(file, { at: option('--at') ?? new Date().toISOString(), to: option('--to') ?? '', kind, reason: option('--reason') ?? '', by: option('--by') ?? '' });
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
}
console.log(`已记一行到 ${file}`);
