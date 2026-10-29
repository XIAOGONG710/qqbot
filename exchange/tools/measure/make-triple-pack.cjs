// node make-triple-pack.cjs <cases.json> <hersA.json> <hersB.json> <输出目录> [题数=30]
// 三选一盲评包（"框架束缚了她吗"那次对照，packages/bot/src/sim/bare.ts，ADR 0175）：
// 每题同一个上文、同一句他说的话，下面有 A / B / C 三条女生的回复，其中一条是真人情侣聊天里的原话，另外两条是她（现有管线 / 不带框架）；
// 评分者选"你认为是真人的那条"（可以再写一句理由）。哪条是谁、顺序都随机，放在 key.json（先别看）。
// 读法（score-triple.cjs）：真人被认出来的比例、两个版本分别被当成真人的比例。三选一的瞎猜水平是 33%：
//   一个版本被当成真人的比例越高越好；两个版本差得多（n=30 时每个比例的误差约 ±9 个点，两个人合起来约 ±6）才有话说。
// 题目和顺序用 id 哈希决定，同一份 cases 重做一遍结果一样；两个版本必须都有这一题的回复才进包。
const fs = require('node:fs');
const path = require('node:path');
const [casesPath, aPath, bPath, outDir, nArg] = process.argv.slice(2);
if (!casesPath || !aPath || !bPath || !outDir) { console.error('用法：node make-triple-pack.cjs <cases.json> <hersA.json> <hersB.json> <输出目录> [题数=30]'); process.exit(2); }
const n = Number(nArg ?? 30);
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const hersA = JSON.parse(fs.readFileSync(aPath, 'utf8'));
const hersB = JSON.parse(fs.readFileSync(bPath, 'utf8'));
const unit = text => {
    let h = 0x811c9dc5;
    for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return (h >>> 0) / 2 ** 32;
};
const usable = cases.filter(item => hersA[item.id]?.length && hersB[item.id]?.length && item.human?.length).sort((a, b) => unit(`${a.id} pick`) - unit(`${b.id} pick`)).slice(0, n);
fs.mkdirSync(outDir, { recursive: true });
const key = {};
const lines = [`# 盲评：哪条是真人女生？（${usable.length} 题）`, '', '每题有三条女生的回复（A / B / C），一条是真人情侣聊天里的女生原话，另外两条是她（程序）。凭感觉选"最像真人的那条"，每题只回一个字母。',
    '先别看 key.json。打完把答案发回来（例如 `1A 2C 3B …`），也可以在后面写一句理由。', ''];
usable.forEach((item, index) => {
    const entries = [{ who: 'human', lines: item.human }, { who: 'A', lines: hersA[item.id] }, { who: 'B', lines: hersB[item.id] }]
        .map(entry => ({ ...entry, order: unit(`${item.id} ${entry.who} order`) })).sort((x, y) => x.order - y.order);
    const letters = ['A', 'B', 'C'];
    key[index + 1] = { id: item.id, ...Object.fromEntries(entries.map((entry, i) => [entry.who, letters[i]])) };
    const context = (item.context ?? []).slice(-6).map(line => `${line.role === 'user' ? '男生' : '女生'}：${line.content}`);
    lines.push(`## ${index + 1}`, '');
    if (context.length) lines.push('前面的聊天：', ...context.map(line => `> ${line}`), '');
    lines.push('男生最新说：', ...item.stimulus.map(line => `> ${line}`), '');
    entries.forEach((entry, i) => lines.push(`**${letters[i]}**`, ...entry.lines.map(line => `> ${line}`), ''));
    lines.push('你选：', '');
});
fs.writeFileSync(path.join(outDir, 'pairs.md'), lines.join('\n'));
fs.writeFileSync(path.join(outDir, 'key.json'), JSON.stringify(key, null, 2));
console.log(`写了 ${usable.length} 题到 ${outDir}（key.json 先别看）`);
