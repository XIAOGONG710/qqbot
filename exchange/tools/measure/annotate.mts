// node annotate.mts <label> <replies.json|human> -> writes annotate-<label>.json and prints the distribution.
// replies.json: { [caseId]: string[] }; "human" = the real girl's reply from ctx-cases.json. The annotator is not told which side is which.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from 'file:///C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src/config.ts';
import { chatCompletion, unlimitedModelGuard } from 'file:///C:/Users/XG/Desktop/Project/qqbot-claude2/packages/bot/src/llm.ts';

unlimitedModelGuard();
const SP = 'C:/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad';
const OUT = 'C:/Users/XG/AppData/Local/Temp/claude/C--Users-XG-Desktop-Project/3ae87421-f778-4ab6-a257-be927b0e8739/scratchpad';
const [label, source] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(`${SP}/ctx-cases.json`, 'utf8')) as { id: string; stimulus: string[]; human: string[] }[];
const replies: Record<string, string[]> = source === 'human' ? Object.fromEntries(cases.map(c => [c.id, c.human])) : JSON.parse(readFileSync(source!, 'utf8'));
const config = loadConfig('C:/Users/XG/Desktop/Project/qqbot-claude2');
const llm = { ...config.llm, temperature: 0 };

const SYSTEM = `你在给中文即时聊天里的“回复方式”做标注。输入是男生这一轮说的话，和女生的回复。只看回复相对于男生那句话的关系，不要猜谁写的。
输出一行 JSON，字段：
mode：下面六个之一
 - "complete"：顺着他的话接，把他说的回应得完整（答了问题、附和并展开、解释、安慰、给建议、把话收圆）
 - "partial"：他说了好几件事 / 好几个问题，她只回了其中一部分，其余没理
 - "bare"：只应一声、笑、一个字、纯表情，没有内容（嗯、哈哈、好、哦、6、表情包）
 - "query"：只回一个很短的追问 / 疑问（？、咋了、什么、啥杯子），没有别的
 - "own"：没接他的话，转去说自己的事、自己的状态，或另起一个话题（跳跃、答非所问、自说自话）
 - "feel"：主要在表达她自己对他 / 对这件事的情绪或态度（委屈、撒娇、生气、嘴硬、吐槽、不想活了这种夸张），而不是在处理他说的事
explains：回复里有没有给理由 / 解释 / 说明（true/false）
advice：有没有劝慰 / 建议 / 叮嘱（true/false）
clever：有没有俏皮的反驳 / 玩梗 / 刻意巧妙的话（true/false）
question：有没有疑问句（true/false）
detail：有没有主动补一个他没问的细节 / 近况（true/false）
yields：她有没有顺从 / 让步 / 认错 / 答应照他说的做 / 马上附和他的批评或建议（行吧、好好好、我注意、那我少吃点、知道啦、不闹了），而不是顶回去、赌气、不服、置之不理（true/false）
只输出这一行 JSON。`;

const results: Record<string, unknown> = {};
const ids = cases.map(c => c.id).filter(id => replies[id]?.length);
let next = 0;
async function worker() {
    while (next < ids.length) {
        const id = ids[next++]!;
        const item = cases.find(c => c.id === id)!;
        try {
            const raw = await chatCompletion(llm, [{ role: 'system', content: SYSTEM }, { role: 'user', content: `男生说：\n${item.stimulus.join('\n')}\n\n女生回复：\n${replies[id]!.join('\n')}` }], { purpose: 'background' });
            const json = /\{[\s\S]*\}/.exec(raw)?.[0];
            if (json) results[id] = JSON.parse(json);
        } catch (error) { console.error(id, error instanceof Error ? error.message : String(error)); }
    }
}
await Promise.all(Array.from({ length: 6 }, worker));
writeFileSync(`${OUT}/annotate-${label}.json`, JSON.stringify(results, null, 1));
const all = Object.values(results) as Record<string, unknown>[];
const count = (f: (r: Record<string, unknown>) => boolean) => `${Math.round((100 * all.filter(f).length) / all.length)}%`;
console.log(`${label}: n=${all.length}`);
for (const mode of ['complete', 'partial', 'bare', 'query', 'own', 'feel']) console.log(`  ${mode.padEnd(9)} ${count(r => r.mode === mode)}`);
for (const flag of ['explains', 'advice', 'clever', 'question', 'detail', 'yields']) console.log(`  ${flag.padEnd(9)} ${count(r => r[flag] === true)}`);
