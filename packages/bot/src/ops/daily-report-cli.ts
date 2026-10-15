// npm run daily-report -w packages/bot -- [YYYY-MM-DD，默认今天] [--data <数据目录>] [--logs <Koishi 日志目录>]
// 只读：读数据目录和日志（不改、不写），把一页 markdown 打印到终端。报告里没有聊天原话。
import { resolve } from 'node:path';
import { buildReport, loadReportData } from './daily-report.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const root = resolve(import.meta.dirname, '../../../..');
const positional = args.filter((arg, at) => !arg.startsWith('--') && !args[at - 1]?.startsWith('--'));
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const date = positional[0] ?? today;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error('日期要写成 YYYY-MM-DD');
    process.exit(2);
}
const data = loadReportData(resolve(option('--data') ?? resolve(root, 'runtime/bot')), resolve(option('--logs') ?? resolve(root, 'runtime/koishi/data/logs')));
console.log(buildReport(data, date));
