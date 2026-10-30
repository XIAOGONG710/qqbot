// 只读：睡眠整合（03:00–07:00）为什么没跑？看常驻进程的日志和 jobs.json，不碰任何别的东西。
// 用法：node night-check.mjs <resident.log> [jobs.json] [时区偏移小时，默认 8]
//   resident.log 在常驻进程的目录里（residentDir()，一般是 ~/.dsh/ 下面某处；找不到就 Get-ChildItem -Recurse -Filter resident.log）
// 输出：每个夜里（前一天 23:00 到当天 08:00）心跳条数和最长的心跳间隔（心跳每 5 分钟一次；间隔很长 = 那段时间进程没在跑或电脑睡着了），
//       以及所有 sleep / wake 的 start / ok / fail 行（只有时刻、标签、耗时）。
import { existsSync, readFileSync } from 'node:fs';

const [logFile, jobsFile, offsetArg] = process.argv.slice(2);
if (!logFile) { console.error('用法：node night-check.mjs <resident.log> [jobs.json] [时区偏移小时]'); process.exit(1); }
const offset = Number(offsetArg ?? 8) * 3_600_000;
const local = at => new Date(at + offset);
const stamp = at => local(at).toISOString().slice(0, 16).replace('T', ' ');

const lines = readFileSync(logFile, 'utf8').split('\n').map(line => {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/.exec(line);
    return m ? { at: Date.parse(m[1]), text: m[2] } : undefined;
}).filter(Boolean);
console.log(`resident.log 可读 ${lines.length} 行；${lines.length ? `${stamp(lines[0].at)} → ${stamp(lines.at(-1).at)}` : ''}`);

if (jobsFile && existsSync(jobsFile)) console.log(`jobs.json：${readFileSync(jobsFile, 'utf8').replace(/\s+/g, ' ').trim()}`);
else console.log('jobs.json：没给或不存在');

console.log('\n| 夜里（日期是那天的 0 点后） | 心跳条数 | 最长心跳间隔（分钟） | 03:00–07:00 内心跳条数 |');
console.log('| --- | --- | --- | --- |');
const beats = lines.filter(l => l.text.startsWith('heartbeat')).map(l => l.at);
const dayStart = at => { const d = local(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offset; };
const byDay = new Map();
for (const at of beats) { const k = dayStart(at); (byDay.get(k) ?? byDay.set(k, []).get(k)).push(at); }
for (const start of [...byDay.keys()].sort()) {
    // 夜里 = 当天 00:00–08:00（前一天 23:00 之后的那一段并进前一天的行里不好看，这里只看 00:00–08:00 一段）
    const inNight = beats.filter(at => at >= start && at < start + 8 * 3_600_000);
    if (!inNight.length && !beats.some(at => at >= start && at < start + 86_400_000)) continue;
    let longest = 0;
    const edges = [start, ...inNight, start + 8 * 3_600_000];
    for (let i = 1; i < edges.length; i++) longest = Math.max(longest, (edges[i] - edges[i - 1]) / 60_000);
    const core = beats.filter(at => at >= start + 3 * 3_600_000 && at < start + 7 * 3_600_000).length;
    console.log(`| ${local(start).toISOString().slice(0, 10)} | ${inNight.length} | ${Math.round(longest)} | ${core} |`);
}

console.log('\nsleep / wake 记录：');
const jobs = lines.filter(l => /^(sleep|wake)(-manual)? (start|ok|fail)/.test(l.text));
console.log(jobs.length ? jobs.map(l => `- ${stamp(l.at)} ${l.text}`).join('\n') : '- 一条都没有（整个日志里没出现过 sleep / wake 的 start）');
console.log('\n（进程重启：）');
const ups = lines.filter(l => l.text.startsWith('resident up') || l.text.startsWith('resident stopping'));
console.log(ups.length ? ups.map(l => `- ${stamp(l.at)} ${l.text.replace(/profile=\S+/, '')}`).join('\n') : '- 没有');
