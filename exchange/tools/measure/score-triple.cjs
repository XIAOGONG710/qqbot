// node score-triple.cjs <key.json> "1A 2C 3B …" ["标签=1A 2B …" …]
// 三选一盲评的计分（make-triple-pack.cjs）：真人被认出来的比例、"现有管线"(A) 和"不带框架"(B) 分别被当成真人的比例。
// 多个评分者：每人一个参数，写成 "标签=答案"；不带标签的当一个人。最后再给合并的数（所有人所有题一起）。
// 三选一瞎猜 = 33%；n 很小，别读太细（n=30 每个比例误差约 ±9 个点）。
const fs = require('node:fs');
const [keyPath, ...rawRaters] = process.argv.slice(2);
if (!keyPath || !rawRaters.length) { console.error('用法：node score-triple.cjs <key.json> "1A 2C …" ["标签=1A 2C …" …]'); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const raters = rawRaters.map((raw, index) => {
    const m = /^([^=\s]{1,20})=(.*)$/s.exec(raw);
    return { label: m ? m[1] : `评分者${index + 1}`, answers: m ? m[2] : raw };
});
const total = { asked: 0, human: 0, A: 0, B: 0 };
for (const { label, answers } of raters) {
    const given = Object.fromEntries([...answers.matchAll(/(\d+)\s*([ABCabc])/g)].map(m => [m[1], m[2].toUpperCase()]));
    const count = { asked: 0, human: 0, A: 0, B: 0 };
    for (const [number, item] of Object.entries(key)) {
        const picked = given[number];
        if (!picked) continue;
        count.asked++;
        const who = ['human', 'A', 'B'].find(w => item[w] === picked);
        if (who) count[who]++;
    }
    for (const field of Object.keys(total)) total[field] += count[field];
    console.log(`${label}：答了 ${count.asked} 题 → 认出真人 ${pct(count.human, count.asked)}；把"现有管线"当真人 ${pct(count.A, count.asked)}；把"不带框架"当真人 ${pct(count.B, count.asked)}`);
}
if (raters.length > 1) console.log(`合并：${total.asked} 题 → 认出真人 ${pct(total.human, total.asked)}；现有管线被当真人 ${pct(total.A, total.asked)}；不带框架被当真人 ${pct(total.B, total.asked)}`);
console.log('瞎猜 = 33%。看"被当成真人"那两个比例谁高、差多少；差不到 10 个点别当结论。');
function pct(x, n) { return n ? `${x} 题（${Math.round(100 * x / n)}%）` : '—'; }
