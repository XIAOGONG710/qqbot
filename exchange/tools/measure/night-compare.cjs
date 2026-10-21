// Compare the late-night test replay before/after the challenge / abstract / stall intents + crutch line.
// usage: node night-compare.cjs <baseline batch dir> <new batch dir>   (each holds night-01/r1..r3/chats/10001.jsonl)
const fs = require('node:fs');
const path = require('node:path');
const bubbles = batch => {
    const out = [];
    const sc = path.join(batch, 'night-01');
    for (const run of fs.readdirSync(sc)) {
        const file = path.join(sc, run, 'chats', '10001.jsonl');
        if (!fs.existsSync(file)) continue;
        const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
        out.push(rows.filter(r => r.role === 'assistant').map(r => r.content.replace(/\[[^\]]{1,12}\]/g, '')));
    }
    return out;
};
const D = /是困得|我的意思|我只是|我是说|我没(?:敷衍|变|说错)|我说的算数|不算跑|不是设定|不是程序|我就是我|哪来什么程序|哪有.{0,6}(?:重复|像)/;
const CRUTCH = /急|突然|困|明天说|改天|太快/;
const APHORISM = /不是.{1,10}[，,]?是|其实.{0,8}不|不用装|踏实|[^，,]{3,}[，,][^，,]{3,}[，,][^，,]{3,}/;
const four = list => { const m = new Map(); for (const t of list) { const c = [...t.replace(/[\s\p{P}\p{S}]/gu, '')]; const seen = new Set(); for (let i = 0; i + 4 <= c.length; i++) seen.add(c.slice(i, i + 4).join('')); for (const g of seen) m.set(g, (m.get(g) ?? 0) + 1); } return [...m].filter(([, n]) => n >= 4).length; };
for (const [label, batch] of [['基线', process.argv[2]], ['新', process.argv[3]]]) {
    const runs = bubbles(batch);
    const all = runs.flat();
    const n = all.length || 1;
    const p = re => `${all.filter(t => re.test(t)).length}（${Math.round(100 * all.filter(t => re.test(t)).length / n)}%）`;
    console.log(`${label}：${runs.length} 次 × 共 ${all.length} 条气泡 | 自证 / 辩解 ${p(D)} | 往后推的字词（急 / 突然 / 困 / 明天说…）${p(CRUTCH)} | 金句体 ${p(APHORISM)} | 同一个 4 字片段出现 >=4 次的有 ${runs.map(r => four(r)).join('/')} 个（每次）`);
}
