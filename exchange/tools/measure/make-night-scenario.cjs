// Turn the user's 10-22 01:00-01:28 late-night messages (the test conversation where "she still sounds like AI") into a replayable scenario.
// His words only go into the scratchpad (never into the repo). Output: night-test/night-01.json
const fs = require('node:fs');
const path = require('node:path');
const rows = fs.readFileSync('C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/2260168937.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && typeof r.content === 'string');
const from = Date.parse('2026-10-22T01:00:00+08:00');
const to = Date.parse('2026-10-22T01:29:00+08:00');
const mine = rows.filter(r => r.role === 'user' && Date.parse(r.time) >= from && Date.parse(r.time) < to && !r.content.startsWith('[图片') && !r.content.startsWith('[动画'));
const steps = [];
let last = from;
for (const r of mine) {
    const t = Date.parse(r.time);
    const gap = Math.round((t - last) / 1000);
    if (gap >= 20) steps.push({ advance: `${Math.min(gap, 240)}s` });
    steps.push({ say: r.content.replace(/^\[引用你说的：.*?\]/, '') });
    last = t;
}
const scenario = {
    name: '深夜测试对话重放',
    description: '用户 10-22 凌晨 01:00 起的真实提问（只在本机临时目录，不进仓库）：看她被追问 / 被指出像 AI / 被求婚时有没有自证、金句体、原地打转',
    tier: 'boyfriend', user: '宝宝', start: '2026-10-22T01:00:00+08:00', memory: false, shortReplies: true, steps,
};
const dir = path.join(__dirname, 'night-test');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'night-01.json'), JSON.stringify(scenario, null, 2));
console.log('steps', steps.length, 'his messages', mine.length);
