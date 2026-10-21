// When do real girlfriends bring their own thing? Split the real boyfriend-relation pairs (agenda-stats.cjs definition) by what HE just said.
const fs = require('node:fs');
const path = require('node:path');
const chars = text => [...text.replace(/\[[^\]]{1,30}\]/g, '')];
const bigrams = text => { const c = chars(text.replace(/[\s\p{P}\p{S}]/gu, '')); const set = new Set(); for (let i = 0; i + 1 < c.length; i++) set.add(c[i] + c[i + 1]); return set; };
const shares = (a, b) => { const sb = bigrams(b); for (const g of bigrams(a)) if (sb.has(g)) return true; return false; };
const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
const pairs = [];
for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) {
    for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
        const seg = JSON.parse(line);
        if (seg.relation !== 'boyfriend') continue;
        const turns = (seg.turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
        for (let i = 1; i < turns.length; i++) if (turns[i].who === seg.her && turns[i - 1].who !== seg.her) pairs.push({ prev: turns[i - 1].bubbles.map(String), turn: turns[i].bubbles.map(String) });
    }
}
const isAgenda = ({ prev, turn }) => { const text = turn.join(''); return text.includes('我') && !shares(text, prev.join('')); };
const isQuestion = prev => prev.some(b => /[？?]/.test(b) || /[吗呢吧]\s*$/.test(b.trim()));
const len = prev => chars(prev.join('').replace(/[\s\p{P}\p{S}]/gu, '')).length;
const rows = [];
const row = (label, pick) => { const sel = pairs.filter(pick); const hit = sel.filter(isAgenda).length; rows.push(`${label.padEnd(22)} n=${String(sel.length).padStart(3)}  自带议程 ${sel.length ? Math.round(1000 * hit / sel.length) / 10 : 0}%`); };
row('全部', () => true);
row('他的话是问句', p => isQuestion(p.prev));
row('他的话不是问句', p => !isQuestion(p.prev));
row('他的话 ≤6 字', p => len(p.prev) <= 6);
row('他的话 7–15 字', p => len(p.prev) > 6 && len(p.prev) <= 15);
row('他的话 >15 字', p => len(p.prev) > 15);
row('不是问句 且 ≤10 字', p => !isQuestion(p.prev) && len(p.prev) <= 10);
row('不是问句 且 >10 字', p => !isQuestion(p.prev) && len(p.prev) > 10);
console.log(rows.join('\n'));
console.log('\n自带议程的例子（他 → 她）：');
for (const p of pairs.filter(isAgenda).slice(0, 14)) console.log(`  ${p.prev.join(' / ').slice(0, 40)}  →  ${p.turn.join(' / ').slice(0, 60)}`);
