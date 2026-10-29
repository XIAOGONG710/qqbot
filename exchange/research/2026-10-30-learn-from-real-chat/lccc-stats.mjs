// 量 LCCC 样本的长短、问句、个人信息痕迹。用法：node lccc-stats.mjs <目录>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const dir = process.argv[2];
const dialogs = [];
for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl.gz'))) {
    for (const line of gunzipSync(readFileSync(join(dir, name))).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { dialogs.push(JSON.parse(line).map(u => u.replace(/\s+/g, ''))); } catch { /* 坏行跳过 */ }
    }
}
const utter = dialogs.flat();
const len = utter.map(u => [...u].length).sort((a, b) => a - b);
const q = arr => (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const pct = (n, d) => `${((100 * n) / d).toFixed(1)}%`;
const turns = {};
for (const d of dialogs) turns[d.length] = (turns[d.length] ?? 0) + 1;
const pii = {
    手机号: /1[3-9]\d{9}/,
    链接: /https?:|www\.|\.com|\.cn/i,
    '@': /@/,
    加联系: /(加我|微信|vx|v信|\bqq\b|扣扣)/i,
    脏话: /(傻逼|sb|操你|妈的|他妈|草泥马|卧槽|尼玛)/i,
};
console.log('对话数', dialogs.length, '句数', utter.length);
console.log('每段句数分布', JSON.stringify(turns));
console.log('每句字数 p10/p25/中位/p75/p90', [0.1, 0.25, 0.5, 0.75, 0.9].map(q(len)).join(' / '));
console.log('≤2 字的句', pct(len.filter(n => n <= 2).length, len.length));
console.log('≤5 字的句', pct(len.filter(n => n <= 5).length, len.length));
console.log('>30 字的句', pct(len.filter(n => n > 30).length, len.length));
console.log('带问号的句', pct(utter.filter(u => /[？?]/.test(u)).length, utter.length));
for (const [k, re] of Object.entries(pii)) console.log(`含「${k}」`, pct(utter.filter(u => re.test(u)).length, utter.length), utter.filter(u => re.test(u)).length);
// 抽样给人看：多轮、每句不长的前 12 段
const sample = dialogs.filter(d => d.length >= 3 && d.every(u => [...u].length <= 25)).slice(0, 12);
console.log('---- 抽样（多轮、每句≤25字）');
for (const d of sample) console.log(d.join(' / '));
