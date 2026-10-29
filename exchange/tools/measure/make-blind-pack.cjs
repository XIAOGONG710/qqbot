// 盲评包（新目录结构）：node make-blind-pack.cjs <cases.json> <answers.json> <输出目录>
//   题面：同一条上文 + 男生的同一句，A/B 各一条女生的回复，一条是真人（cases 里的 human），一条是她（answers.json）。
//   A/B 顺序按 id 的哈希决定，可复现，不随机；答案在 key.json，评分人先别看。
//   版本标签（commit / 是否脏 / 时间）写进 meta.json，评分包本身不带这些。
// 旧版读的是写死的会话临时目录里的 ctx-cases.json + prep-hers2.cjs 的产物；那两样都不在了，改成读仓库里的 cases 与 answers。
const fs = require('node:fs');
const path = require('node:path');

const [casesPath, answersPath, outDir] = process.argv.slice(2);
if (!casesPath || !answersPath || !outDir) {
    console.error('用法：node make-blind-pack.cjs <cases.json> <answers.json> <输出目录>');
    process.exit(2);
}

const hash = (text) => {
    let h = 0x811c9dc5;
    for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return (h >>> 0) / 2 ** 32;
};

const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const set = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
const hers = new Map((set.answers ?? []).map(a => [a.id, (a.bubbles ?? []).map(b => b.text).filter(Boolean)]));

const usable = cases.filter(c => hers.get(c.id)?.length && (c.human ?? []).length);
const dropped = cases.length - usable.length;

fs.mkdirSync(outDir, { recursive: true });
const key = {};
const lines = [
    `# 盲评：哪个是真人女生？（${usable.length} 题）`,
    '',
    '每题里是同一个场景：男生说完最后一句话，两个女生各回了一条。一个是真人（聊天截图里的女生），一个是她。',
    '凭感觉选**更像真人的那个**，每题回 **A** 或 **B**，可以再写一句理由；分不出就写「平」。',
    '打完把答案发我（例如 `1A 2B 3B …`）。先别看 key.json。',
    '',
];

usable.forEach((c, index) => {
    const humanFirst = hash(`${c.id} order`) < 0.5;
    const [a, b] = humanFirst ? [c.human, hers.get(c.id)] : [hers.get(c.id), c.human];
    key[index + 1] = { id: c.id, sourceId: c.sourceId, human: humanFirst ? 'A' : 'B', probe: c.probe ?? '', relation: c.relation, scene: c.scene };
    const ctx = (c.context ?? []).slice(-6);
    lines.push(`## ${index + 1}`, '');
    if (ctx.length) lines.push('前面的聊天：', ...ctx.map(line => `> ${line}`), '');
    lines.push('男生最新说：', ...c.stimulus.map(line => `> ${line}`), '', '**A**', ...a.map(line => `> ${line}`), '', '**B**', ...b.map(line => `> ${line}`), '', '你选：', '');
});

fs.writeFileSync(path.join(outDir, 'pairs.md'), lines.join('\n'));
fs.writeFileSync(path.join(outDir, 'key.json'), JSON.stringify(key, null, 2));
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    cases: path.resolve(casesPath),
    answers: path.resolve(answersPath),
    commit: set.commit ?? null,
    dirty: set.dirty ?? null,
    answeredAt: set.createdAt ?? null,
    questions: usable.length,
    droppedNoAnswer: dropped,
    generatedAt: new Date().toISOString(),
}, null, 2));
console.log(`写了 ${usable.length} 题到 ${outDir}（没有她的回答或没有真人回复的 ${dropped} 题被跳过）`);
