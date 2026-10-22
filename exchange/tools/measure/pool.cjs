// usage: node pool.cjs label1 label2 ... ; pools annotate-<label>-v*.json and judge-ctx-<label>-v*.json; also prints the human row
const fs = require('node:fs'); const path = require('node:path');
const SP = __dirname;
const MODES = ['complete', 'partial', 'bare', 'query', 'own', 'feel'];
const FLAGS = ['explains', 'advice', 'clever', 'question', 'detail', 'yields'];
function pool(prefix) {
    const files = fs.readdirSync(SP).filter(f => f.startsWith(`annotate-${prefix}`) && f.endsWith('.json'));
    const all = files.flatMap(f => Object.values(JSON.parse(fs.readFileSync(path.join(SP, f), 'utf8'))));
    return { n: all.length, files: files.length, all };
}
function row(name, all) {
    const pct = f => `${Math.round(100 * all.filter(f).length / all.length)}`.padStart(3);
    return `${name.padEnd(12)} n=${String(all.length).padStart(3)} | ` + MODES.map(m => `${m} ${pct(r => r.mode === m)}`).join(' ') + ' | ' + FLAGS.map(m => `${m} ${pct(r => r[m] === true)}`).join(' ');
}
const human = Object.values(JSON.parse(fs.readFileSync(path.join(SP, 'annotate-human-ctx.json'), 'utf8')));
console.log(row('human', human));
for (const label of process.argv.slice(2)) {
    const p = pool(`${label}-v`);
    console.log(row(label, p.all) + `  (${p.files} runs)`);
    const js = fs.readdirSync(SP).filter(f => f.startsWith(`judge-ctx-${label}-v`) && f.endsWith('.json')).flatMap(f => JSON.parse(fs.readFileSync(path.join(SP, f), 'utf8')));
    if (js.length) console.log(`   judge picked human ${Math.round(100 * js.filter(v => v.ok).length / js.length)}% of ${js.length}`);
}
