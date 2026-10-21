// Turn-level share containing laugh / sprawl tokens anywhere (attached or standalone), human girls vs his own messages vs her (live + replays).
const fs = require('node:fs');
const path = require('node:path');
const TOKENS = { 笑: /哈哈|嘿嘿|嘻嘻|呵呵|[hH]{3,}|噗|笑死|xswl|绷不住/, 拖长: /(.)\1{2,}|[啊嗯哦呜诶]{2,}|～|~/, 语气词收尾: /[啦嘛呀哦哟喔咯嘞]\s*[!！。.…~～]*$/, 感叹: /[!！]/ , 省略号: /\.{2,}|…|。。/, 表情: /\[[^\]]{1,6}\]|[\u{1F300}-\u{1FAFF}]/u };
function rep(label, turns) {
    const n = turns.length || 1; const out = [];
    for (const [k, re] of Object.entries(TOKENS)) { const c = turns.filter(t => t.some(b => re.test(b))).length; out.push(`${k} ${Math.round(1000 * c / n) / 10}%`); }
    console.log(label.padEnd(26), `轮 ${String(turns.length).padStart(4)} |`, out.join('  '));
}
const human = [];
const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) { const seg = JSON.parse(line); if (seg.relation !== 'boyfriend') continue; for (const t of seg.turns ?? []) if (t.who === seg.her && Array.isArray(t.bubbles) && t.bubbles.length) human.push(t.bubbles.map(String)); }
rep('真人女生（样本）', human);
function live(dir, want) { const out = []; for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.jsonl')) continue; let cur = [], who = ''; for (const r of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)) { if (typeof r.content !== 'string') continue; if (r.role !== who) { if (who === want && cur.length) out.push(cur); cur = []; who = r.role; } cur.push(r.content); } if (who === want && cur.length) out.push(cur); } return out; }
const dir = 'C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats';
rep('他本人（线上）', live(dir, 'user'));
rep('她（线上 10-05 起）', live(dir, 'assistant'));

// replay dirs: node laugh-attached.cjs label=dir1,dir2 ...
function sim(roots) { const out = []; for (const root of roots) for (const sc of fs.readdirSync(root)) { const sd = path.join(root, sc); if (!fs.statSync(sd).isDirectory()) continue; for (const run of fs.readdirSync(sd)) { const file = path.join(sd, run, 'chats', '10001.jsonl'); if (!fs.existsSync(file)) continue; let cur = [], who = ''; for (const r of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))) { if (r.role !== who) { if (who === 'assistant' && cur.length) out.push(cur); cur = []; who = r.role; } cur.push(r.content); } if (who === 'assistant' && cur.length) out.push(cur); } } return out; }
for (const arg of process.argv.slice(2)) { const [label, dirs] = arg.split('='); rep(label, sim(dirs.split(','))); }
