// 汇总一份填好的三选一包：字母 / 「平」/ 多字母（AC都行）/ 直接抄选项原文，四种都认
//   用法：node score-triple-user.cjs <填好的 pairs.md> <key.json>
const fs = require('node:fs');

const [packPath, keyPath] = process.argv.slice(2);
const md = fs.readFileSync(packPath, 'utf8');
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const norm = (s) => s.replace(/[\s，,。.！!？?~～…、""'']/g, '');

const blocks = md.split(/^## (\d+)\s*$/m).slice(1);
const rows = [];
for (let i = 0; i < blocks.length; i += 2) {
    const no = Number(blocks[i]);
    const body = blocks[i + 1];
    const raw = (/你选[：:]\s*([^\n]*)/.exec(body)?.[1] ?? '').trim();
    const opts = {};
    for (const m of body.matchAll(/\*\*([ABC])\*\*\n((?:>.*\n?)+)/g)) {
        opts[m[1]] = m[2].split('\n').map(l => l.replace(/^>\s?/, '').trim()).filter(Boolean);
    }
    rows.push({ no, raw, opts });
}

const resolve = (item) => {
    const raw = item.raw;
    if (!raw) return { kind: 'blank' };
    if (/^平$|^分不出$/.test(raw)) return { kind: 'tie' };
    const letters = [...new Set((raw.match(/[ABC]/g) ?? []))];
    if (letters.length > 1) return { kind: 'ambiguous', letters };
    if (letters.length === 1 && /^[ABC](\s|，|,|$)/.test(raw)) return { kind: 'letter', letter: letters[0] };
    const n = norm(raw);
    const hits = Object.entries(item.opts).filter(([, lines]) => lines.some(l => norm(l) === n));
    if (hits.length === 1) return { kind: 'text', letter: hits[0][0] };
    return { kind: 'unresolved' };
};

let right = 0, wrong = 0, tie = 0, ambiguous = 0, unresolved = 0;
const arm = {};
const lines = [];
for (const item of rows) {
    const k = key[String(item.no)];
    const human = k?.human;
    const r = resolve(item);
    let verdict = '?';
    if (r.kind === 'tie') { tie++; verdict = '平（不计）'; }
    else if (r.kind === 'ambiguous') { ambiguous++; verdict = `多选 ${r.letters.join('')}（不计）`; }
    else if (r.kind === 'unresolved' || r.kind === 'blank') { unresolved++; verdict = '认不出（不计）'; }
    else {
        const picked = k?.[r.letter];
        if (picked) arm[picked] = (arm[picked] ?? 0) + 1;
        if (r.letter === human) { right++; verdict = '对'; } else { wrong++; verdict = '错'; }
    }
    lines.push(`${item.no}\t${r.letter ?? r.letters?.join('') ?? '-'}\t真人=${human ?? '?'}\t${verdict}\t${r.kind}\t${item.raw.slice(0, 20)}`);
}

const judged = right + wrong;
console.log(lines.join('\n'));
console.log('');
console.log(JSON.stringify({
    判了: judged,
    命中真人: right,
    判错: wrong,
    记平: tie,
    多选不计: ambiguous,
    认不出不计: unresolved,
    命中率: judged ? +(right / judged * 100).toFixed(1) : null,
    本包总题: rows.length,
    被当成真人的臂: arm,
}, null, 1));
