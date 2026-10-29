// 离线看：LCCC 当例子池，给那 72 题挑出来的例子像不像样（不调模型）。
// 用法：node lccc-retrieval.mjs <lccc 数据目录> <ctx-cases.json> <仓库 exemplars.ts 的绝对路径>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const [dir, casesPath, modulePath] = process.argv.slice(2);
const { pickExemplars } = await import(pathToFileURL(modulePath).href);

const BAD = /(1[3-9]\d{9}|https?:|www\.|\.com|加我|微信|vx|v信|\bqq\b|扣扣|傻逼|操你|妈的|他妈|尼玛)/i;
const pool = [];
for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl.gz'))) {
    for (const [index, line] of gunzipSync(readFileSync(join(dir, name))).toString('utf8').split('\n').filter(Boolean).entries()) {
        let dialog;
        try { dialog = JSON.parse(line).map(u => u.replace(/\s+/g, '')); } catch { continue; }
        if (dialog.length < 2 || dialog.length > 8 || dialog.some(u => [...u].length > 20 || BAD.test(u))) continue;
        for (let i = 0; i + 1 < dialog.length; i++) {
            pool.push({ id: `${name}#${index}.${i}`, source: `LCCC/${name}#${index}`, license: 'MIT(card);research-disclaimer', said: dialog[i], replied: [dialog[i + 1]] });
        }
    }
}
console.log('例子池', pool.length, '条（对话 2–8 句、每句 ≤20 字、去联系方式/脏话）');

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const len = s => [...s].length;
let withPick = 0, picked = 0, pickedShort = 0, pickedLens = [];
const humanLens = cases.flatMap(c => (c.human ?? []).map(len));
const shown = [];
for (const c of cases) {
    const said = c.stimulus.join('');
    const got = pickExemplars(pool, said, { k: 4 });
    if (got.length) withPick++;
    for (const g of got) { picked++; const n = len(g.replied[0]); pickedLens.push(n); if (n <= 2) pickedShort++; }
    if (shown.length < 10 && got.length) shown.push({ said, human: (c.human ?? []).join(' / '), got: got.map(g => `「${g.said}」→「${g.replied[0]}」`) });
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`72 题里挑得出例子的 ${withPick}/${cases.length}`);
console.log(`挑出的回复 中位字数 ${med(pickedLens)}（真人 ${med(humanLens)}），≤2 字占 ${((100 * pickedShort) / picked).toFixed(1)}%`);
for (const s of shown) { console.log('\n他说：', s.said); console.log('真人回：', s.human); for (const g of s.got) console.log('  例', g); }
