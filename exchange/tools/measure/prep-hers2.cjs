// usage: node prep-hers2.cjs <out hers.json> <sim batch dir> ... ; collects her LAST reply run (consecutive assistant rows at the end of the chat file)
const fs = require('node:fs');
const path = require('node:path');
const [out, ...roots] = process.argv.slice(2);
const hers = {};
for (const root of roots) {
    for (const id of fs.readdirSync(root)) {
        const file = path.join(root, id, 'r1', 'chats', '10001.jsonl');
        if (!fs.existsSync(file)) continue;
        const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        const bubbles = [];
        for (let i = rows.length - 1; i >= 0 && rows[i].role === 'assistant'; i--) bubbles.unshift(rows[i].content.trim());
        if (bubbles.length) hers[id] = bubbles;
    }
}
fs.writeFileSync(out, JSON.stringify(hers, null, 2));
console.log(`collected ${Object.keys(hers).length} replies`);
