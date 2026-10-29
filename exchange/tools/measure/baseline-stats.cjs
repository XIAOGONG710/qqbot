// 基线数字：她的回复 vs 真人回复，同一批 39 题（cases-40 去掉她没回的那题）
//   node baseline-stats.cjs <cases.json> <answers.json>
// 只输出可复算的计数，不评价好坏：气泡数、每泡字数、问句率、表情率、句号率、单字回复率。
const fs = require('node:fs');

const [casesPath, answersPath] = process.argv.slice(2);
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const set = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
const hers = new Map((set.answers ?? []).map(a => [a.id, (a.bubbles ?? []).map(b => b.text).filter(Boolean)]));

const usable = cases.filter(c => hers.get(c.id)?.length && (c.human ?? []).length);

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\[[^\]]{1,6}\]/u;
const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function stats(groups) {
    const bubbles = groups.flat();
    const perCase = groups.map(g => g.length);
    const chars = bubbles.map(b => [...b].length);
    return {
        题数: groups.length,
        气泡总数: bubbles.length,
        平均每题材气泡: +(bubbles.length / groups.length).toFixed(2),
        每题材气泡中位数: median(perCase),
        每条气泡字数中位数: median(chars),
        问句率: +(bubbles.filter(b => /[?？]/.test(b)).length / bubbles.length * 100).toFixed(1),
        表情率: +(bubbles.filter(b => EMOJI.test(b)).length / bubbles.length * 100).toFixed(1),
        句号率: +(bubbles.filter(b => /[。.]$/.test(b)).length / bubbles.length * 100).toFixed(1),
        单字气泡率: +(bubbles.filter(b => [...b].length <= 2).length / bubbles.length * 100).toFixed(1),
        超20字气泡率: +(bubbles.filter(b => [...b].length > 20).length / bubbles.length * 100).toFixed(1),
    };
}

const hersGroups = usable.map(c => hers.get(c.id));
const humanGroups = usable.map(c => c.human);
const out = {
    题数: usable.length,
    她的: stats(hersGroups),
    真人: stats(humanGroups),
    她没回的题: cases.length - usable.length,
    版本: { commit: set.commit ?? null, dirty: set.dirty ?? null, answeredAt: set.createdAt ?? null },
};
console.log(JSON.stringify(out, null, 1));
