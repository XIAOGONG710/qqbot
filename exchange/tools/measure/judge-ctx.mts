// Blind judge WITH the real context lines. node judge-ctx.mts <hers.json> [label] [--reasons]
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from 'file:///C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src/config.ts';
import { chatCompletion, unlimitedModelGuard } from 'file:///C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src/llm.ts';
import { unit } from 'file:///C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src/expression.ts';
unlimitedModelGuard();
const SP = 'C:/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad';
const [hersPath, label = ''] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(`${SP}/ctx-cases.json`, 'utf8')) as { id: string; stimulus: string[]; human: string[]; context: { role: string; content: string }[] }[];
const hers = JSON.parse(readFileSync(hersPath!, 'utf8')) as Record<string, string[]>;
const llm = { ...loadConfig('C:/Users/XG/Desktop/Project/qqbot-claude2').llm, temperature: 0 };
const SYSTEM = [
    '你是聊天记录鉴别员。下面是一段中文即时聊天（先是前面的聊天，再是男生最新发的话），和两个女生的回复（A 和 B）。其中一个是真人女生当时发的，另一个是 AI 写的。',
    '判断哪一个是真人。真人的回复常常不完整、跳跃、带情绪、有口头习惯、有时答非所问或只应一声；AI 写的常常过于得体、很会接话、爱用巧妙的反问或反驳、每句都完整。',
    '只输出两行：第一行只写 A 或 B（你认为是真人的那个）；第二行用不超过 25 个字说明你判断的依据（说你认为 AI 的那个哪里像 AI）。',
].join('\n');
const verdicts: { id: string; ok: boolean; reason: string }[] = [];
let next = 0;
async function worker() {
    while (next < cases.length) {
        const item = cases[next++]!;
        const reply = hers[item.id];
        if (!reply?.length) continue;
        const humanFirst = unit(`${item.id} order`) < 0.5;
        const [a, b] = humanFirst ? [item.human, reply] : [reply, item.human];
        const ctx = item.context.length ? `前面的聊天：\n${item.context.slice(-8).map(l => `${l.role === 'user' ? '男生' : '女生'}：${l.content}`).join('\n')}\n\n` : '';
        try {
            const raw = await chatCompletion(llm, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${ctx}男生最新说：\n${item.stimulus.join('\n')}\n\nA：\n${a.join('\n')}\n\nB：\n${b.join('\n')}` }], { purpose: 'background' });
            const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
            const pick = /^[AB]/i.exec(lines[0] ?? '')?.[0]?.toUpperCase();
            if (pick) verdicts.push({ id: item.id, ok: (pick === 'A') === humanFirst, reason: lines.slice(1).join(' ').slice(0, 60) });
        } catch (e) { console.error(item.id, String(e)); }
    }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(`${SP}/judge-ctx-${label}.json`, JSON.stringify(verdicts, null, 1));
const ok = verdicts.filter(v => v.ok).length;
console.log(`judge-ctx ${label}: n=${verdicts.length}, picked human ${Math.round(100 * ok / verdicts.length)}% (fooled ${Math.round(100 * (verdicts.length - ok) / verdicts.length)}%)`);
if (process.argv.includes('--reasons')) for (const v of verdicts.filter(v => v.ok)) console.log('  -', v.reason);
