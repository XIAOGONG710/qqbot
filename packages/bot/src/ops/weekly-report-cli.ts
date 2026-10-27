// node src/ops/weekly-report-cli.ts [--dir <数据目录>] [--qq <QQ号>] [--tier boyfriend] [--since 2026-11-15] [--write]（周报，ADR 0118）
//   默认打印最近 7 天的“她离真人还差多少”（只有数字，没有原话）；--write 同时写进 <数据目录>/reports/weekly-<本周日>.md
// 数据目录默认 runtime/bot；QQ 号默认读 config.json 里第一个男朋友档联系人，读不到就要自己给 --qq

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { weeklyReport, writeWeeklyReport } from '../platform/weekly-report.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const tier = one('--tier') ?? 'boyfriend';
let qq = Number(one('--qq'));
if (!qq) {
    const configFile = join(dataDir, 'config.json');
    if (existsSync(configFile)) {
        const config = JSON.parse(readFileSync(configFile, 'utf8')) as { contacts?: { qq: number; tier: string }[] };
        qq = config.contacts?.find(c => c.tier === tier)?.qq ?? 0;
    }
}
if (!qq) { console.error('不知道是哪个联系人：用 --qq 给 QQ 号'); process.exit(2); }
const now = Date.now();
const since = one('--since') ? Date.parse(one('--since')!) : now - 7 * 86_400_000;
if (Number.isNaN(since)) { console.error('--since 要写成 2026-11-15 这样的日期'); process.exit(2); }
const input = { dataDir, qq, tier, since, now };
console.log(weeklyReport(input));
if (args.includes('--write')) console.log(`已写入 ${writeWeeklyReport({ ...input, reportsDir: join(dataDir, 'reports') })}`);
