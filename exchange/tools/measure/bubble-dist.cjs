// Bubbles per her turn: human girls (boyfriend samples), his own turns, her live, and sim runs.
const fs = require('node:fs'); const path = require('node:path');
const dist = turns => { const c = [0, 0, 0, 0]; for (const t of turns) c[Math.min(t.length, 4) - 1]++; const n = turns.length || 1; return `n=${String(turns.length).padStart(4)}  1条 ${Math.round(100 * c[0] / n)}%  2条 ${Math.round(100 * c[1] / n)}%  3条 ${Math.round(100 * c[2] / n)}%  4+条 ${Math.round(100 * c[3] / n)}%  均 ${(turns.reduce((s, t) => s + t.length, 0) / n).toFixed(2)}`; };
const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
const human = [], hisHuman = [];
for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) { const seg = JSON.parse(line); if (seg.relation !== 'boyfriend') continue; for (const t of seg.turns ?? []) if (Array.isArray(t.bubbles) && t.bubbles.length) (t.who === seg.her ? human : hisHuman).push(t.bubbles); }
console.log('真人女生（样本）'.padEnd(22), dist(human));
console.log('真人男生（样本）'.padEnd(22), dist(hisHuman));
function sim(roots) { const out = []; for (const root of roots) for (const sc of fs.readdirSync(root)) { const sd = path.join(root, sc); if (!fs.statSync(sd).isDirectory()) continue; for (const run of fs.readdirSync(sd)) { const file = path.join(sd, run, 'chats', '10001.jsonl'); if (!fs.existsSync(file)) continue; let cur = [], who = ''; for (const r of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))) { if (r.role !== who) { if (who === 'assistant' && cur.length) out.push(cur); cur = []; who = r.role; } cur.push(r.content); } if (who === 'assistant' && cur.length) out.push(cur); } } return out; }
for (const arg of process.argv.slice(2)) { const [label, dirs] = arg.split('='); console.log(label.padEnd(22), dist(sim(dirs.split(',')))); }
