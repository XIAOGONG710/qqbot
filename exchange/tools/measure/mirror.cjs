// Per turn (his burst -> her reply): her chars vs his chars, over all sim chat files of one batch. Prints numbers only.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const chars = text => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;
const turns = [];
const bubbles = [];
for (const scenario of fs.readdirSync(root)) {
    const sd = path.join(root, scenario);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const run of fs.readdirSync(sd)) {
        const file = path.join(sd, run, 'chats', '10001.jsonl');
        if (!fs.existsSync(file)) continue;
        const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        let his = 0;
        let hers = 0;
        let n = 0;
        let had = false;
        const flush = () => { if (had && n) { turns.push({ his, hers, n }); } his = 0; hers = 0; n = 0; had = false; };
        for (const row of rows) {
            if (row.role === 'user') { if (n) flush(); his += chars(row.content); had = true; }
            else { hers += chars(row.content); n++; bubbles.push(chars(row.content)); }
        }
        flush();
    }
}
const q = (list, p) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rank = list => { const idx = list.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(list.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const spearman = (a, b) => { const ra = rank(a); const rb = rank(b); const ma = ra.reduce((x, y) => x + y, 0) / ra.length; const mb = rb.reduce((x, y) => x + y, 0) / rb.length; let num = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; } return num / Math.sqrt(da * db); };
const ratios = turns.map(t => t.hers / Math.max(1, t.his));
console.log(`turns ${turns.length}; bubbles ${bubbles.length}`);
console.log(`bubble chars: median ${q(bubbles, 0.5)} p25 ${q(bubbles, 0.25)} p75 ${q(bubbles, 0.75)} p90 ${q(bubbles, 0.9)}  <=4: ${Math.round(100 * bubbles.filter(n => n <= 4).length / bubbles.length)}%  >=15: ${Math.round(100 * bubbles.filter(n => n >= 15).length / bubbles.length)}%`);
console.log(`bubbles per turn: 1=${Math.round(100 * turns.filter(t => t.n === 1).length / turns.length)}% 2=${Math.round(100 * turns.filter(t => t.n === 2).length / turns.length)}% 3+=${Math.round(100 * turns.filter(t => t.n >= 3).length / turns.length)}%`);
console.log(`her/his chars per turn: median ${q(ratios, 0.5).toFixed(1)} p90 ${q(ratios, 0.9).toFixed(1)}; hers per turn median ${q(turns.map(t => t.hers), 0.5)} (his median ${q(turns.map(t => t.his), 0.5)}); mirroring (Spearman) ${(100 * spearman(turns.map(t => t.his), turns.map(t => t.hers))).toFixed(0)}/100`);
