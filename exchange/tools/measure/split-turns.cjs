const fs = require('node:fs'); const path = require('node:path');
let n = 0, got = 0; const out = [];
for (const root of process.argv.slice(2)) for (const sc of fs.readdirSync(root)) {
    const sd = path.join(root, sc); if (!fs.statSync(sd).isDirectory()) continue;
    for (const run of fs.readdirSync(sd)) {
        const file = path.join(sd, run, 'report.md'); if (!fs.existsSync(file)) continue;
        for (const block of fs.readFileSync(file, 'utf8').split(/\n(?=- `[^`]*` \*\*对方\*\*：)/)) {
            const his = /\*\*对方\*\*：(.*)/.exec(block)?.[1]; if (!his) continue;
            const m = /分成 (\d) 条发/.exec(block); if (!m) continue;
            const hers = [...block.matchAll(/^- `[^`]*` 她：(.*)$/gm)].map(x => x[1]);
            n++; if (hers.length >= 2) got++;
            if (out.length < 40) out.push(`[要${m[1]}条→${hers.length}条] ${sc}/${run} 他：${his.slice(0, 36)}\n      她：${hers.join(' / ')}`);
        }
    }
}
console.log(`被要求分条的轮次 ${n}，实际 >=2 条 ${got}（${Math.round(100 * got / (n || 1))}%）`); console.log(out.join('\n'));
