// 人设差异：DSH profile 的快照 vs QQ 的卡（「同一个她」任务书 §1 第 2 条）
//   用法：node scripts/persona-diff.mjs [输出 md]
// 口径：两边的正文都按【小节】切，逐行去格式后比。
//   输出三栏——只在 DSH 里 / 只在卡里 / 两边都写了但说法不一致（同一小节里有差异行）。
// 不改任何一份；结论交给用户逐条定（默认卡赢）。
import { readFileSync, writeFileSync } from 'node:fs';

const profilePath = 'characters/linmengyao/dsh/profile-lmy.md';
const cardPath = 'characters/linmengyao/st/linmengyao-boyfriend-open.json';
const out = process.argv[2] ?? 'exchange/research/2026-10-29-persona-diff.md';

const strip = (text) => text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const lines = (text) => strip(text)
    .split(/\n|(?<=。)/)
    .map(l => l.trim())
    .filter(l => l.length >= 4);

/** 按【小节】切；小节外的行归到「开头」 */
function sections(text, fallbackName) {
    const map = new Map();
    let current = fallbackName;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // 小节标记可能在一行中间（卡里是「【和他的关系】 你和他是……」），先按标记切段
        const chunks = line.split(/(?=【)/);
        for (const chunk of chunks) {
            const m = /^【(.+?)】\s*/.exec(chunk);
            const body = m ? chunk.slice(m[0].length) : chunk;
            if (m) { current = m[1]; if (!map.has(current)) map.set(current, []); }
            if (!map.has(current)) map.set(current, []);
            if (body.trim()) map.get(current).push(...lines(body));
        }
    }
    return map;
}

const profile = sections(strip(readFileSync(profilePath, 'utf8')), '开头');
const cardData = JSON.parse(readFileSync(cardPath, 'utf8')).data;
const card = sections(strip([cardData.description, cardData.personality, cardData.scenario, cardData.post_history_instructions].join('\n')), '开头');

// 比内容不比分身：把「我 / 你 / 咱」都当成她，卡是第二人称写的、profile 是第一人称写的
const norm = (s) => s.replace(/[我你咱您]/g, '她').replace(/[「」“”"'’，,。.！!？?；;：:\s]/g, '');

// 逐小节比：同名（或互相包含）的算同一节
const matchKey = (name, pool) => [...pool.keys()].find(k => norm(k) === norm(name)) ?? [...pool.keys()].find(k => norm(k).includes(norm(name)) || norm(name).includes(norm(k)));

const rows = [];
const seenCard = new Set();
for (const [name, list] of profile) {
    const key = matchKey(name, card);
    if (!key) { rows.push({ section: name, kind: '只在 DSH 里', only: list }); continue; }
    seenCard.add(key);
    const other = new Set(card.get(key).map(norm));
    const mine = new Set(list.map(norm));
    const added = list.filter(l => !other.has(norm(l)));
    const missing = card.get(key).filter(l => !mine.has(norm(l)));
    if (added.length || missing.length) rows.push({ section: name, kind: '两边说法不一致', only: added, missing });
}
for (const [name, list] of card) {
    if (!seenCard.has(name)) rows.push({ section: name, kind: '只在卡里', missing: list });
}

const md = [
    '# 人设差异：DSH profile lmy vs QQ 的男朋友档卡（2026-10-29）',
    '',
    '任务书 §1 第 2 条。**只列差异，不改任何一份**；默认卡赢（卡有测试、分档、披露规则），DSH 独有且有价值的并进卡的新段落，走 `characters/` 评审。',
    '',
    `- DSH：\`${profilePath}\`（${[...profile.values()].reduce((n, l) => n + l.length, 0)} 行）`,
    `- QQ：\`${cardPath}\` → description + personality + scenario + post_history_instructions（${[...card.values()].reduce((n, l) => n + l.length, 0)} 行）`,
    '',
    '## 一、只在 DSH 里（卡里没有）',
    '',
];
for (const r of rows.filter(r => r.kind === '只在 DSH 里')) {
    md.push(`### ${r.section}`, '');
    for (const l of r.only) md.push(`- ${l}`);
    md.push('');
}
md.push('## 二、只在卡里（DSH 没有）', '');
for (const r of rows.filter(r => r.kind === '只在卡里')) {
    md.push(`### ${r.section}`, '');
    for (const l of r.missing) md.push(`- ${l}`);
    md.push('');
}
md.push('## 三、两边都写了、说法不一致', '');
for (const r of rows.filter(r => r.kind === '两边说法不一致')) {
    md.push(`### ${r.section}`, '', '| 只在 DSH | 只在卡里 |', '| --- | --- |');
    const n = Math.max(r.only.length, r.missing.length);
    for (let i = 0; i < n; i++) md.push(`| ${r.only[i] ?? ''} | ${r.missing[i] ?? ''} |`);
    md.push('');
}
md.push(`## 统计`, '', `- 小节：DSH ${profile.size} 个，卡 ${card.size} 个`, `- 差异小节：${rows.length} 个（只 DSH ${rows.filter(r => r.kind === '只在 DSH 里').length} · 只卡 ${rows.filter(r => r.kind === '只在卡里').length} · 不一致 ${rows.filter(r => r.kind === '两边说法不一致').length}）`, '');
writeFileSync(out, md.join('\n'));
console.log(`写了 ${out}；差异小节 ${rows.length} 个`);
