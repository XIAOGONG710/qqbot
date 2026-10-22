// node make-blind-pack.cjs <hers.json> <输出目录> [题数=30]
// 盲评包：同一个带上文的场景里，真人女生的回复和她的回复各一份，A / B 顺序随机，答案另放 key.json（先别看）。
// 给用户（和第二个评分的人）打分用：每题只回“A”或“B”（你认为是真人的那个），可再写一句理由；打完用 score-blind.cjs 出百分比。
// 数据来源：exchange/research/2026-10-real-chat 的带上文场景（ctx-cases.json，在会话临时目录里，路径写死）+ prep-hers2.cjs 取出的她的回复。
// 读法：她被认成真人的比例越接近 50%，说明越分不出来；明显低于 50% 说明还是露馅（每题 1 个人的判断，n=30 时误差约 ±9 个点，别读太细）。
const fs = require('node:fs');
const path = require('node:path');
const SP = 'C:/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad';
const [hersPath, outDir, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 30);
const cases = JSON.parse(fs.readFileSync(path.join(SP, 'ctx-cases.json'), 'utf8'));
const hers = JSON.parse(fs.readFileSync(hersPath, 'utf8'));
const unit = text => {
    let h = 0x811c9dc5;
    for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return (h >>> 0) / 2 ** 32;
};
const usable = cases.filter(item => hers[item.id]?.length && item.human?.length).sort((a, b) => unit(`${a.id} pick`) - unit(`${b.id} pick`)).slice(0, n);
fs.mkdirSync(outDir, { recursive: true });
const key = {};
const lines = [`# 盲评：哪个是真人女生？（${usable.length} 题）`, '', '每题里有两个女生的回复（A / B），一个是真人情侣聊天截图里的女生，一个是她。凭感觉选“更像真人的那个”，每题回 **A** 或 **B**，可以再写一句理由。',
    '先别看 key.json。打完把答案发我（例如 `1A 2B 3B …`），我来算。', ''];
usable.forEach((item, index) => {
    const humanFirst = unit(`${item.id} order`) < 0.5;
    const [a, b] = humanFirst ? [item.human, hers[item.id]] : [hers[item.id], item.human];
    key[index + 1] = { id: item.id, human: humanFirst ? 'A' : 'B' };
    const context = (item.context ?? []).slice(-6).map(line => `${line.role === 'user' ? '男生' : '女生'}：${line.content}`);
    lines.push(`## ${index + 1}`, '');
    if (context.length) lines.push('前面的聊天：', ...context.map(line => `> ${line}`), '');
    lines.push('男生最新说：', ...item.stimulus.map(line => `> ${line}`), '', '**A**', ...a.map(line => `> ${line}`), '', '**B**', ...b.map(line => `> ${line}`), '', '你选：', '');
});
fs.writeFileSync(path.join(outDir, 'pairs.md'), lines.join('\n'));
fs.writeFileSync(path.join(outDir, 'key.json'), JSON.stringify(key, null, 2));
console.log(`写了 ${usable.length} 题到 ${outDir}`);
