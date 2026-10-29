// node stats.cjs <cases.json> <标签=hers.json> ...   ——真人 vs 各个版本的结构指标（和 DSH 的 baseline-stats.cjs 同一组口径）
const fs = require('node:fs');
const [casesPath, ...arms] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\[[^\]]{1,6}\]|[（(][^）)]{1,4}[）)]/u;
const len = s => [...s].length;
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const pct = (x, n) => (n ? `${(100 * x / n).toFixed(1)}%` : '—');
function stats(turns) {
    const bubbles = turns.flat().map(s => s.trim()).filter(Boolean);
    const lens = bubbles.map(len);
    return {
        题数: turns.length,
        气泡数每题: (bubbles.length / turns.length).toFixed(2),
        每条字数中位数: median(lens),
        超20字: pct(lens.filter(n => n > 20).length, lens.length),
        两字以内: pct(lens.filter(n => n <= 2).length, lens.length),
        带问号: pct(bubbles.filter(b => /[?？]/.test(b)).length, bubbles.length),
        带表情: pct(bubbles.filter(b => EMOJI.test(b)).length, bubbles.length),
        句号结尾: pct(bubbles.filter(b => /[。.]$/.test(b)).length, bubbles.length),
    };
}
const rows = [];
const armData = arms.map(arm => { const [label, file] = arm.split('='); return [label, JSON.parse(fs.readFileSync(file, 'utf8'))]; });
// 只比所有版本都有回复的题
const ids = cases.filter(c => c.human?.length && armData.every(([, hers]) => hers[c.id]?.length)).map(c => c.id);
rows.push(['真人', stats(ids.map(id => cases.find(c => c.id === id).human))]);
for (const [label, hers] of armData) rows.push([label, stats(ids.map(id => hers[id]))]);
console.log(`共同的 ${ids.length} 题`);
const keys = Object.keys(rows[0][1]).filter(k => k !== '题数');
console.log(['版本', ...keys].join('\t'));
for (const [label, s] of rows) console.log([label, ...keys.map(k => s[k])].join('\t'));
