// 读用户填的「你选：」，对上 30 题的三条选项，算出真人命中数
//   用法：node score-user-pack.cjs <填好的 pairs.md> <key.json>
const fs = require('node:fs');

const [packPath, keyPath] = process.argv.slice(2);
const md = fs.readFileSync(packPath, 'utf8');
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));

// 切题：## N ... 到下一个 ## N
const blocks = md.split(/^## (\d+)\s*$/m).slice(1);
const items = [];
for (let i = 0; i < blocks.length; i += 2) {
    const no = Number(blocks[i]);
    const body = blocks[i + 1];
    const pickLine = /你选[：:]\s*([^\n]*)/.exec(body);
    const raw = (pickLine?.[1] ?? '').trim();
    const opts = {};
    for (const m of body.matchAll(/\*\*([ABC])\*\*\n((?:>.*\n?)+)/g)) {
        opts[m[1]] = m[2].split('\n').map(l => l.replace(/^>\s?/, '').trim()).filter(Boolean);
    }
    items.push({ no, raw, opts });
}

const norm = (s) => s.replace(/[\s，,。.！!？?~～…、""'']/g, '');

function decide(item) {
    const raw = item.raw;
    const letter = /^([ABC])/i.exec(raw)?.[1]?.toUpperCase();
    if (letter) return { choice: letter, how: '字母' };
    if (/^平$/.test(raw)) return { choice: '平', how: '平' };
    const n = norm(raw);
    const hits = Object.entries(item.opts).filter(([, lines]) => lines.some(l => norm(l) === n || (n.length >= 2 && norm(l).includes(n)) || (norm(l).length >= 2 && n.includes(norm(l)))));
    if (hits.length === 1) return { choice: hits[0][0], how: '按原文对上' };
    return { choice: null, how: `认不出（候选 ${hits.map(h => h[0]).join('') || '无'}）` };
}

let right = 0, wrong = 0, tie = 0;
const rows = [];
for (const item of items) {
    const d = decide(item);
    const k = key[String(item.no)];
    const human = k?.human ?? k?.humanLetter;
    let verdict = '—';
    if (d.choice === '平') { tie++; verdict = '平（不计）'; }
    else if (d.choice && human) {
        if (d.choice === human) { right++; verdict = '对'; } else { wrong++; verdict = '错'; }
    }
    rows.push([item.no, d.choice ?? '?', human ?? '?', verdict, d.how, item.raw.slice(0, 18)].join('\t'));
}

console.log(rows.join('\n'));
const judged = right + wrong;
console.log(`\n命中 ${right}/${judged}${tie ? `（另有 ${tie} 题记平，不计）` : ''}，认不出的 ${items.filter(i => !decide(i).choice).length} 题`);
