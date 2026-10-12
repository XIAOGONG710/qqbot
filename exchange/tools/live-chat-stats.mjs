// 只读：把她在线上的真实回复按「轮」（间隔 ≤ 20 秒的连发算一轮）统计，和真人基线并排；按天出一行，方便看趋势
// 用法：node live-chat-stats.mjs <聊天 jsonl 路径> [起始日期 YYYY-MM-DD，默认 2026-10-11]
// 真人基线（DSH 的 10-09/10 语料）：一轮 1 条 51–65%、2 条 22–28%、3 条以上 13.6–23%；每条中位 6–7 字；问句率 10–16%（口径不同，仅作参照）
// 聊天文件在 runtime/bot/chats/<QQ>.jsonl（线上，被忽略）；只读它，不要把输出里的原话推进仓库——这里只打印前 40 个字符用于自己核对
import { readFileSync } from 'node:fs';
const [file, from = '2026-10-11'] = process.argv.slice(2);
if (!file) { console.error('用法：node live-chat-stats.mjs <聊天 jsonl> [起始日期]'); process.exit(1); }
const rows = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.role && r.content && new Date(r.time) >= new Date(`${from}T00:00:00+08:00`));
const cp = s => [...s].length;
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const isQuestion = t => t.b.some(b => /[？?]$/.test(b.trim()) || /[吗呢]$/.test(b.trim()));
const turns = []; let cur = null;
for (const r of rows) {
    if (r.role !== 'assistant') { cur = null; continue; }
    const t = Date.parse(r.time);
    if (cur && t - cur.last <= 20_000) { cur.b.push(r.content); cur.last = t; } else { cur = { b: [r.content], last: t, start: r.time }; turns.push(cur); }
}
const day = t => new Date(t.start).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
const report = (label, list) => {
    const n = list.length; if (!n) return;
    const c = [0, 0, 0, 0]; for (const t of list) c[Math.min(3, t.b.length)]++;
    const bubbles = list.flatMap(t => t.b); const pct = x => `${Math.round(100 * x / n)}%`;
    console.log(`${label.padEnd(10)} 轮 ${String(n).padStart(3)} ｜ 1条 ${pct(c[1]).padStart(4)} 2条 ${pct(c[2]).padStart(4)} 3+条 ${pct(c[3]).padStart(4)} ｜ 每条中位 ${median(bubbles.map(cp))} 字 ｜ 带问句的轮 ${pct(list.filter(isQuestion).length)}`);
};
report('全部', turns);
for (const d of [...new Set(turns.map(day))]) report(d, turns.filter(t => day(t) === d));
console.log('\n基线： 1条 51–65% 2条 22–28% 3+条 13.6–23% ｜ 每条中位 6–7 字 ｜ 问句 10–16%');
