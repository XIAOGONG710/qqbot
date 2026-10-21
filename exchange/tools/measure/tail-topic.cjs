// "Unrelated tail" rate: share of her turns (any length) whose LAST bubble, in a turn of >=2 bubbles, shares no two-char word with his previous turn and is not a question.
// A looser, apples-to-apples way to count "she added something of her own after answering" than the 「我」-based agenda definition (her facts rarely say 「我」).
// Human reference: real girl-side turns of the boyfriend-relation samples (same files agenda-stats.cjs uses).
const fs = require('node:fs');
const path = require('node:path');
const chars = text => [...text.replace(/\[[^\]]{1,30}\]/g, '')];
const bigrams = text => { const c = chars(text.replace(/[\s\p{P}\p{S}]/gu, '')); const set = new Set(); for (let i = 0; i + 1 < c.length; i++) set.add(c[i] + c[i + 1]); return set; };
const shares = (a, b) => { const sb = bigrams(b); for (const g of bigrams(a)) if (sb.has(g)) return true; return false; };
function measure(pairs) {
    let tail = 0;
    for (const { prev, turn } of pairs) {
        if (turn.length < 2) continue;
        const last = turn[turn.length - 1];
        if (/[？?]/.test(last) || /[吗呢吧]\s*$/.test(last.trim())) continue;
        if (bigrams(last).size === 0) continue;
        if (!shares(last, prev.join(''))) tail++;
    }
    return `n=${pairs.length}  无关的结尾条 ${Math.round(1000 * tail / (pairs.length || 1)) / 10}%`;
}
function humanPairs() {
    const base = 'C:/Users/XG/Desktop/Project/qqbot-exchange/exchange/research/2026-10-real-chat';
    const out = [];
    for (const f of ['samples.jsonl', 'v2/samples-b1.jsonl', 'v2/samples-b2.jsonl', 'v2/samples-b3.jsonl']) {
        for (const line of fs.readFileSync(path.join(base, f), 'utf8').split(/\r?\n/).filter(Boolean)) {
            const seg = JSON.parse(line);
            if (seg.relation !== 'boyfriend') continue;
            const turns = (seg.turns ?? []).filter(t => Array.isArray(t.bubbles) && t.bubbles.length);
            for (let i = 1; i < turns.length; i++) if (turns[i].who === seg.her && turns[i - 1].who !== seg.her) out.push({ prev: turns[i - 1].bubbles.map(String), turn: turns[i].bubbles.map(String) });
        }
    }
    return out;
}
function simPairs(roots) {
    const out = [];
    for (const root of roots) for (const sc of fs.readdirSync(root)) {
        const sd = path.join(root, sc);
        if (!fs.statSync(sd).isDirectory()) continue;
        for (const run of fs.readdirSync(sd)) {
            const file = path.join(sd, run, 'chats', '10001.jsonl');
            if (!fs.existsSync(file)) continue;
            const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
            let prev = [], cur = [], who = '';
            const flush = () => { if (who === 'assistant' && cur.length && prev.length) out.push({ prev, turn: cur }); };
            for (const r of rows) {
                if (r.role !== who) { flush(); if (who) prev = who === 'user' ? cur : prev; cur = []; who = r.role; }
                cur.push(r.content);
            }
            flush();
        }
    }
    return out;
}
console.log('真人（女方一侧）'.padEnd(26), measure(humanPairs()));
// args: label=dir1,dir2 ...
for (const arg of process.argv.slice(2)) {
    const [label, dirs] = arg.split('=');
    console.log(label.padEnd(26), measure(simPairs(dirs.split(','))));
}
