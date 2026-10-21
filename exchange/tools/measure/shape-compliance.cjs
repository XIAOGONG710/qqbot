// For a shape-on sim batch: pair each "这一轮形状" log line with the following "已回复（N 条）：X 字" line and report, per plan kind,
// how many turns, mean chars per bubble, and how often the average bubble stayed within cap.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const rows = [];
for (const scenario of fs.readdirSync(root)) {
    const sd = path.join(root, scenario);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const run of fs.readdirSync(sd)) {
        const log = path.join(sd, run, 'sim.log');
        if (!fs.existsSync(log)) continue;
        let plan;
        for (const line of fs.readFileSync(log, 'utf8').split(/\r?\n/)) {
            const p = /这一轮形状：每条不超过 (\d+) 字、最多 (\d) 条（(\w+)）/.exec(line);
            if (p) { plan = { cap: Number(p[1]), max: Number(p[2]), kind: p[3] }; continue; }
            // 一条的写「已回复：4 字」，多条的写「已回复（2 条）：32 字」
            const r = /已回复(?:（(\d+) 条）)?：(\d+) 字/.exec(line);
            if (r && plan) { rows.push({ ...plan, bubbles: r[1] ? Number(r[1]) : 1, chars: Number(r[2]) }); plan = undefined; }
            else if (r) { rows.push({ cap: 0, max: 0, kind: 'none', bubbles: r[1] ? Number(r[1]) : 1, chars: Number(r[2]) }); }
        }
    }
}
const kinds = ['micro', 'short', 'medium', 'long', 'wide', 'none'];
for (const kind of kinds) {
    const list = rows.filter(row => row.kind === kind);
    if (!list.length) continue;
    const per = list.map(row => row.chars / row.bubbles);
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    const within = list.filter(row => row.chars / row.bubbles <= row.cap + Math.max(2, Math.ceil(row.cap * 0.35))).length;
    const oneBubble = list.filter(row => row.bubbles === 1).length;
    console.log(`${kind.padEnd(6)} 轮数 ${String(list.length).padStart(3)}  每条平均 ${mean.toFixed(1)} 字（上限 ${list[0].cap}）  平均没超上限 ${Math.round(100 * within / list.length)}%  一条的占 ${Math.round(100 * oneBubble / list.length)}%`);
}
console.log('总计', rows.length, '轮；条数分布', [1, 2, 3].map(n => `${n}条 ${Math.round(100 * rows.filter(r => r.bubbles === n).length / rows.length)}%`).join('  '));
