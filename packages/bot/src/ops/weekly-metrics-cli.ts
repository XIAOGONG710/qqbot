// npm run metrics:weekly -w @qqbot/bot -- [--data <数据目录>] [--days 7] [--until YYYY-MM-DD] [--qq <QQ号>] [--json] [--compare] [--no-log]
// 每周效果数（ADR 0348）：读数据目录里的聊天记录，打印每天 / 整周的数（只有数，没有原话），
// 并在 <数据目录>/logs/weekly-metrics.jsonl 追加一行（--no-log 不写）。--compare 和日志里同一范围的上一次比。
// 窗口默认是「到昨天为止的 7 个整天」：周一跑就是上周一到周日。数据目录默认线上 Koishi 配置的 dataDir，读不到配置用 runtime/bot-shadow。
// 除了追加那一行日志，什么都不改。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { applyTimeZone, canonicalTimeZone, DEFAULT_TIME_ZONE } from '../platform/time-zone.ts';
import { dayKey } from '../language/speech-notes.ts';
import { configuredDataDir, REPO_ROOT } from './data-dir.ts';
import {
    appendRun, compareMetrics, computeWeeklyMetrics, formatMetrics, loadMetricsData, metricsLogPath, previousRun, windowOf,
} from './weekly-metrics.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const fail = (message: string): never => {
    console.error(message);
    console.error('用法：npm run metrics:weekly -w @qqbot/bot -- [--data <数据目录>] [--days 7] [--until YYYY-MM-DD] [--qq <QQ号>] [--json] [--compare] [--no-log]');
    process.exit(2);
};

const configured = configuredDataDir() ?? 'runtime/bot-shadow';
const dataDir = option('--data')
    ? resolve(process.env.INIT_CWD ?? process.cwd(), option('--data')!)
    : isAbsolute(configured) ? configured : resolve(REPO_ROOT, configured);
if (!existsSync(join(dataDir, 'chats'))) fail(`数据目录里没有 chats/：${dataDir}`);

// 她的日界按数据目录配置里的时区（ADR 0331），没写就是默认时区
let zone = DEFAULT_TIME_ZONE;
try {
    const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { timeZone?: unknown };
    if (config.timeZone !== undefined) zone = canonicalTimeZone(config.timeZone);
} catch { /* 没有配置或读不了：用默认时区 */ }
applyTimeZone(zone);

const days = option('--days') === undefined ? 7 : Number(option('--days'));
const now = new Date();
const until = option('--until') ?? dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime());
const qqText = option('--qq');
const qq = qqText === undefined ? undefined : Number(qqText);
if (qq !== undefined && !(Number.isSafeInteger(qq) && qq > 0)) fail('--qq 要是 QQ 号');

let window: { from: number; to: number } = { from: 0, to: 0 };
try { window = windowOf(until, days); } catch (error) { fail((error as Error).message); }
const { chats, proactiveIds } = loadMetricsData(dataDir, qq);
if (qq !== undefined && !chats.size) fail(`没有这个联系人的聊天记录：…${String(qq).slice(-4)}`);
const scope = qq === undefined ? 'all' : `qq…${String(qq).slice(-4)}`;
const metrics = computeWeeklyMetrics({ chats, proactiveIds, ...window, scope });

const logPath = metricsLogPath(dataDir);
const previous = args.includes('--compare') ? previousRun(logPath, scope) ?? null : undefined;
const compare = previous === undefined ? undefined : previous ? { previous, deltas: compareMetrics(previous.week, metrics.week) } : null;
if (!args.includes('--no-log')) appendRun(logPath, metrics, now);

if (args.includes('--json')) {
    console.log(JSON.stringify({ ...metrics, ...(compare === undefined ? {} : { compare: compare && { previousAt: compare.previous.at, deltas: compare.deltas } }) }, null, 2));
} else {
    console.log(formatMetrics(metrics, compare));
    if (!args.includes('--no-log')) console.log(`已记一行：${logPath}`);
}
