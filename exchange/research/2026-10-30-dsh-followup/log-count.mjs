// 只读：数一份 bot 日志（runtime/bot*/logs/<日期>.log）里几类行每小时出现多少次，不输出日志内容。
// 用法：node log-count.mjs <日期.log> [自定义正则，默认见下]
// 默认数这几类：锁（已有一个 bot 在运行 / 拿不到锁 / 插件没有启动）、记忆（记忆召回失败 / 公共记忆召回失败 / 记忆写入失败 / 写进公共记忆失败 / fetch failed）、
//   启动（记忆：bank … 已写入 mission，每启动一次 Koishi 里的 bot 会出现一次）、开关行（开关：）。
// 看什么：① 15:49–17:25 之间「已有一个 bot 在运行」有没有——有，说明后起的几个实例被锁挡住了、没有处理消息；一条都没有，说明锁没起作用。
//         ② 「记忆召回失败」集中在哪几个钟头——Hindsight 停着的时候，她这几轮是不带记忆在说话。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法：node log-count.mjs <日期.log> [正则]'); process.exit(1); }
const classes = process.argv[3]
    ? [['自定义', new RegExp(process.argv[3])]]
    : [
        ['锁挡住/没拿到', /已有一个 bot 在运行|拿不到锁|插件没有启动/],
        ['端口被占', /EADDRINUSE|address already in use/i],
        ['记忆召回失败', /召回失败/],
        ['记忆写入失败', /写入失败|写进公共记忆失败/],
        ['fetch failed', /fetch failed/],
        ['bank 写入 mission（≈启动次数）', /已写入 mission/],
        ['开关行', /开关：/],
    ];
// 两种日志都认：① bot 自己的 logs/<日期>.log（行首 `[2026/10/30 17:25:01] `）；
// ② Koishi 自己的 runtime/koishi/data/logs/<日期>-N.log（一行一个 JSON，有 timestamp 毫秒时间戳和 content；一天会有好几个文件，每个都跑一遍）。
// **插件启动时抛的错（「已有一个 bot 在运行」「插件没有启动」）和「开关：」那一行是 ctx.logger 打的，只在 ②里，bot 自己的日志里没有。**
const HOUR = /^\[\d{4}\/\d{1,2}\/\d{1,2} (\d{1,2}):/;
const OFFSET_H = Number(process.env.TZ_OFFSET_HOURS ?? 8);
function parse(line) {
    const m = HOUR.exec(line);
    if (m) return { hour: m[1].padStart(2, '0'), text: line };
    if (line.startsWith('{')) {
        try {
            const row = JSON.parse(line);
            const at = row.timestamp ?? row.t;
            if (typeof at !== 'number') return undefined;
            return { hour: String(new Date(at + OFFSET_H * 3_600_000).getUTCHours()).padStart(2, '0'), text: String(row.content ?? '') };
        } catch { return undefined; }
    }
    return undefined;
}
const table = new Map(); // 小时 → 各类计数
let total = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
    const parsed = parse(line);
    if (!parsed) continue;
    total++;
    const hour = parsed.hour;
    classes.forEach(([, re], i) => {
        if (!re.test(parsed.text)) return;
        const row = table.get(hour) ?? new Array(classes.length).fill(0);
        row[i]++;
        table.set(hour, row);
    });
}
console.log(`带时间的日志行 ${total}`);
console.log(`| 小时 | ${classes.map(([name]) => name).join(' | ')} |`);
console.log(`| --- | ${classes.map(() => '---').join(' | ')} |`);
for (const hour of [...table.keys()].sort()) console.log(`| ${hour} | ${table.get(hour).join(' | ')} |`);
if (!table.size) console.log('（这些类别一条都没出现）');
