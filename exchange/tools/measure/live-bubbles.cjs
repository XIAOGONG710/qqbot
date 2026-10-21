// Live chat (the boyfriend contact): bubbles per her turn by day, reply bubble length, how often a turn ends with a question, and how often she opens (a turn after >=20 min of silence).
const fs = require('node:fs');
const file = 'C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/2260168937.jsonl';
const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && typeof r.content === 'string');
const day = r => new Date(Date.parse(r.time) + 8 * 3600e3).toISOString().slice(0, 10);
const turns = []; let cur = null;
for (const r of rows) {
    if (!cur || cur.role !== r.role) { cur = { role: r.role, day: day(r), bubbles: [], t: Date.parse(r.time) }; turns.push(cur); }
    cur.bubbles.push(r.content);
}
const byDay = new Map();
for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== 'assistant') continue;
    const prev = turns[i - 1];
    const d = byDay.get(t.day) ?? { turns: 0, one: 0, two: 0, three: 0, bubbles: 0, chars: 0, q: 0, opens: 0, replies: 0, hisBubbles: 0, hisTurns: 0 };
    d.turns++; d.bubbles += t.bubbles.length; d.chars += t.bubbles.join('').length;
    if (t.bubbles.length === 1) d.one++; else if (t.bubbles.length === 2) d.two++; else d.three++;
    if (t.bubbles.some(b => /[？?]/.test(b))) d.q++;
    if (!prev || prev.role === 'assistant') d.opens++; else d.replies++;
    byDay.set(t.day, d);
}
for (const t of turns) if (t.role === 'user') { const d = byDay.get(t.day); if (d) { d.hisTurns++; d.hisBubbles += t.bubbles.length; } }
console.log('day         her-turns  1条  2条  3+条  avg-bub  chars/bub  带问号  她先开口(无前文用户轮)');
for (const [k, d] of [...byDay].sort()) {
    const p = x => `${Math.round(100 * x / d.turns)}%`.padStart(4);
    console.log(`${k}  ${String(d.turns).padStart(8)}  ${p(d.one)} ${p(d.two)} ${p(d.three)}  ${(d.bubbles / d.turns).toFixed(2).padStart(7)}  ${(d.chars / d.bubbles).toFixed(1).padStart(8)}  ${p(d.q)}  ${String(d.opens).padStart(6)}`);
}
