// node score-blind.cjs <key.json> "1A 2B 3B …"   →  她被认成真人的比例（认错的比例）和各题对错
const fs = require('node:fs');
const [keyPath, answers] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
const given = Object.fromEntries([...answers.matchAll(/(\d+)\s*([ABab])/g)].map(m => [m[1], m[2].toUpperCase()]));
let asked = 0, right = 0;
const wrong = [];
for (const [number, item] of Object.entries(key)) {
    if (!given[number]) continue;
    asked++;
    if (given[number] === item.human) right++;
    else wrong.push(number);
}
console.log(`答了 ${asked} 题：认出真人 ${right} 题（${Math.round(100 * right / asked)}%），把她当成真人 ${asked - right} 题（${Math.round(100 * (asked - right) / asked)}%）`);
console.log(`50% 左右 = 分不出；认出真人的比例越高，她越露馅。把她当成真人的题：${wrong.join('、') || '无'}`);
