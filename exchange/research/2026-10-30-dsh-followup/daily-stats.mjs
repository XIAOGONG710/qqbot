// 只读：把一份聊天记录（chats/<QQ>.jsonl）按天数一遍——条数、她每条的中位字数、一次回几条、两字以内占比、原样重复。
// 不输出任何聊天内容（只有数字和日期）。用法：node daily-stats.mjs <聊天记录.jsonl> [时区偏移小时，默认 8]
// 用来回答三件事：① 历史从哪天开始、有没有断档（B1）；② 说话长短有没有回升；③ 同一句话是不是被发了好几遍（4 个 Koishi 的说法）。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('用法：node daily-stats.mjs <聊天记录.jsonl> [时区偏移小时]'); process.exit(1); }
const offset = Number(process.argv[3] ?? 8) * 3_600_000;
const rows = readFileSync(file, 'utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(row => row && row.time && (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string')
    .map(row => ({ ...row, at: Date.parse(row.time) }))
    .filter(row => Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at);
if (!rows.length) { console.log('没有可读的行'); process.exit(0); }

const day = at => new Date(at + offset).toISOString().slice(0, 10);
const len = text => [...text.replace(/\s+/g, '')].length;
const median = list => { if (!list.length) return '-'; const s = [...list].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const days = new Map();
const get = key => { if (!days.has(key)) days.set(key, { user: 0, bubbles: [], replies: 0, dupAssistant: 0, dupUser: 0 }); return days.get(key); };
let prev;
let lastAssistant = new Map(); // 内容 → 最近一次的时刻
let lastUser = new Map();
for (const row of rows) {
    const d = get(day(row.at));
    if (row.role === 'user') {
        d.user++;
        const before = lastUser.get(row.content);
        if (before !== undefined && row.at - before <= 10_000 && row.content.trim()) d.dupUser++;
        lastUser.set(row.content, row.at);
    } else {
        d.bubbles.push(len(row.content));
        if (!prev || prev.role !== 'assistant') d.replies++;
        const before = lastAssistant.get(row.content);
        if (before !== undefined && row.at - before <= 10_000 && row.content.trim()) d.dupAssistant++;
        lastAssistant.set(row.content, row.at);
    }
    prev = row;
}

console.log(`文件行数（可读）${rows.length}；第一条 ${new Date(rows[0].at + offset).toISOString().slice(0, 16)}，最后一条 ${new Date(rows.at(-1).at + offset).toISOString().slice(0, 16)}（UTC${offset >= 0 ? '+' : ''}${offset / 3_600_000}）`);
console.log('');
console.log('| 日期 | 他 | 她(气泡) | 一次回几条 | 每条中位字数 | ≤2字占比 | 10秒内原样重复(她) | (他) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const key of [...days.keys()].sort()) {
    const d = days.get(key);
    const short = d.bubbles.length ? Math.round(100 * d.bubbles.filter(n => n <= 2).length / d.bubbles.length) + '%' : '-';
    const per = d.replies ? (d.bubbles.length / d.replies).toFixed(2) : '-';
    console.log(`| ${key} | ${d.user} | ${d.bubbles.length} | ${per} | ${median(d.bubbles)} | ${short} | ${d.dupAssistant} | ${d.dupUser} |`);
}

// 断档：相邻两条隔了超过 18 小时的，只列日期
const gaps = [];
for (let i = 1; i < rows.length; i++) {
    const hours = (rows[i].at - rows[i - 1].at) / 3_600_000;
    if (hours > 18) gaps.push(`${new Date(rows[i - 1].at + offset).toISOString().slice(0, 16)} → ${new Date(rows[i].at + offset).toISOString().slice(0, 16)}（${hours.toFixed(1)} 小时）`);
}
console.log('');
console.log(gaps.length ? `超过 18 小时没有任何一条的间隔：\n- ${gaps.join('\n- ')}` : '没有超过 18 小时的间隔');
