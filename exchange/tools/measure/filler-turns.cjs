// Turns whose prompt carried the 废话 line or the 拖音 note: his words and her bubbles.
const fs = require('node:fs'); const path = require('node:path');
let f = 0, s = 0; const out = [];
for (const root of process.argv.slice(2)) for (const sc of fs.readdirSync(root)) {
    const sd = path.join(root, sc); if (!fs.statSync(sd).isDirectory()) continue;
    for (const run of fs.readdirSync(sd)) {
        const file = path.join(sd, run, 'report.md'); if (!fs.existsSync(file)) continue;
        for (const block of fs.readFileSync(file, 'utf8').split(/\n(?=- `[^`]*` \*\*对方\*\*：)/)) {
            const his = /\*\*对方\*\*：(.*)/.exec(block)?.[1]; if (!his) continue;
            const isF = block.includes('只回一条，不超过 4 个字，只'); const isS = block.includes('他在用「～」或拖长音说话');
            if (!isF && !isS) continue;
            const hers = [...block.matchAll(/^- `[^`]*` 她：(.*)$/gm)].map(m => m[1]);
            if (isF) f++; if (isS) s++;
            out.push(`${isF ? '[废话]' : '[拖音]'} ${sc}/${run}  他：${his.slice(0, 40)}\n      她：${hers.join(' / ') || '(无)'}`);
        }
    }
}
console.log(`废话轮 ${f}，拖音轮 ${s}`); console.log(out.join('\n'));
