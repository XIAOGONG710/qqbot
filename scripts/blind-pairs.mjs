// 盲评材料（ADR 0043 上线门槛「匿名混排人工盲评」，长期计划第 8 节）：两批模拟器结果在同一回合上的回复配成对，随机标 A / B，
// 出一份给人打分的 Markdown 和一份单独存的答案（哪个是哪批）。只用模拟器的虚构聊天。
//
// node scripts/blind-pairs.mjs <批次目录 1> <批次目录 2> <输出目录> [场景名]
//   批次目录是 runtime/sim/<时间>-<标签>，两批要是同一个场景、同样的步骤；输出 blind.md、key.json
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [dirA, dirB, out, only] = process.argv.slice(2);
if (!dirA || !dirB || !out) {
    console.error('用法：node scripts/blind-pairs.mjs <批次目录 1> <批次目录 2> <输出目录> [场景名]');
    process.exit(1);
}

/** 一批里每次运行的每个回合：case 编号、说明、他说的、她回的、前面两句 */
function turns(dir) {
    const scenario = only ?? readdirSync(dir).find(name => !name.includes('.'));
    const base = join(dir, scenario);
    const runs = readdirSync(base).filter(name => /^r\d+$/.test(name)).sort();
    return runs.map(run => {
        const result = JSON.parse(readFileSync(join(base, run, 'result.json'), 'utf8'));
        const list = [];
        let current;
        let generated = 0;
        const said = [];
        for (const step of result.steps) {
            if (step.kind === 'case') current = { id: step.caseId, note: step.note };
            if (step.kind !== 'say') continue;
            const his = (step.inputs ?? []).map(input => input.text).join(' / ');
            const hers = (step.bubbles ?? []).map(bubble => bubble.text).join(' / ');
            // 她这几句真的是回这一句的吗：这一步最后一次生成的提示词（prompts/<第几次生成>.json）里最后一条他的消息要是这一步他说的
            // （回复晚到、落进下一步的不算，免得题目错位）
            generated += step.generations?.length ?? 0;
            let lastHis = '';
            try {
                const saved = JSON.parse(readFileSync(join(base, run, 'prompts', `${generated}.json`), 'utf8'));
                lastHis = (saved.messages ?? []).filter(message => message.role === 'user').at(-1)?.content ?? '';
            } catch { /* 没存提示词的批次：认不出来就不收 */ }
            const aligned = Boolean(step.generations?.length) && (step.inputs ?? []).some(input => lastHis.includes(input.text));
            if (current && hers && aligned) list.push({ case: current.id, note: current.note, before: said.slice(-2), his, hers });
            said.push(`他：${his}`);
            if (hers) said.push(`她：${hers}`);
        }
        return { run, list };
    });
}

const a = turns(dirA);
const b = turns(dirB);
// 固定种子的洗牌，同样的输入出同样的材料
let seed = 20261009;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const items = [];
for (let r = 0; r < Math.min(a.length, b.length); r++) {
    for (const turnA of a[r].list) {
        const turnB = b[r].list.find(t => t.case === turnA.case);
        if (!turnB) continue;
        const flip = random() < 0.5;
        items.push({
            id: `${a[r].run}-${turnA.case}`,
            note: turnA.note,
            before: turnA.before,
            his: turnA.his,
            A: flip ? turnB.hers : turnA.hers,
            B: flip ? turnA.hers : turnB.hers,
            key: { A: flip ? basename(dirB) : basename(dirA), B: flip ? basename(dirA) : basename(dirB) },
        });
    }
}
for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
}

const lines = [
    '# 盲评：哪一句更像真人女朋友会回的',
    '',
    `共 ${items.length} 题。每题是同一个场景里同一句话的两种回法（A、B 随机，看不出来自哪种做法）。`,
    '每题写：**更像真人的是 A / B / 差不多**，觉得假的地方随手记一句（「太客气」「答非所问」「像客服」「突然说自己的事」……）。',
    '前面那两句是这一回合之前的聊天（两种做法前面的聊天不一定完全一样，只作背景）。名字和聊天都是虚构的。',
    '',
];
items.forEach((item, i) => {
    lines.push(`## ${i + 1}.（${item.note}）`, '');
    for (const line of item.before) lines.push(`> ${line}`);
    lines.push(`> **他：${item.his}**`, '', `- **A**：${item.A}`, `- **B**：${item.B}`, '', '更像真人：＿＿　假的地方：＿＿', '');
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'blind.md'), lines.join('\n'));
writeFileSync(join(out, 'key.json'), JSON.stringify(items.map((item, i) => ({ n: i + 1, id: item.id, ...item.key })), null, 2) + '\n');
console.log(`${items.length} 题 → ${join(out, 'blind.md')}（答案在 key.json，别给打分的人看）`);
