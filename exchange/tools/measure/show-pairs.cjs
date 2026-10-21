// Print his line -> her bubbles pairs from sim chat files of one batch (sampled evenly), to read the quality by eye.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const want = Number(process.argv[3] ?? 30);
const pairs = [];
for (const scenario of fs.readdirSync(root)) {
    const sd = path.join(root, scenario);
    if (!fs.statSync(sd).isDirectory()) continue;
    for (const run of fs.readdirSync(sd)) {
        const file = path.join(sd, run, 'chats', '10001.jsonl');
        if (!fs.existsSync(file)) continue;
        const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        let user = [];
        let her = [];
        for (const row of rows) {
            if (row.role === 'user') { if (her.length) { pairs.push({ scenario, user, her }); user = []; her = []; } user.push(row.content); }
            else her.push(row.content);
        }
        if (user.length && her.length) pairs.push({ scenario, user, her });
    }
}
const step = Math.max(1, Math.floor(pairs.length / want));
for (let i = 0; i < pairs.length && i / step < want; i += step) {
    const p = pairs[i];
    console.log(`${p.scenario.slice(0, 14).padEnd(14)} 他：${p.user.join(' / ').slice(0, 40)}  →  她：${p.her.join(' / ')}`);
}
