// node src/ops/meme-cli.ts list|add|remove [--dir <数据目录>]（她知道的网络热梗，ADR 0129）
//   list                                          列出库里的梗（词、把握、意思、出现几次、最近一次）
//   add "<词>" "<一句话意思>" [--example "<例句>"]  作者手动加一个（比如你刷到她还不知道的新梗）；把握记“高”
//   remove "<词>"                                 删掉一个（学错了 / 不想让她用）
// 库在 <数据目录>/memes/memes.json（默认 runtime/bot）；她自己每 12 小时从热榜学新的（配置 memes + bilibiliAccount），手动加的同样受 45 天过期约束——
// 过期是按“最近一次在榜上出现”算的，手动加的从加的那天起算，之后不在榜上就会过期；想长期留着，隔一阵再 add 一次。
// 手动加的也过敏感词（政治、灾难、案件、低俗、骂人的一律不收）和长度检查。

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMemes, MEME_BLOCK, memesPath, saveMemes, trimMemes, type MemeEntry } from '../memes.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const path = memesPath(dir);
const command = args[0];
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1]!.startsWith('--')));
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

if (command === 'list') {
    const file = loadMemes(path);
    if (!file.entries.length) console.log('库是空的（她会自己从热榜学；也可以 add 一个）');
    for (const e of file.entries) console.log(`「${e.term}」 [${e.confidence === 'high' ? '高' : '中'}] 出现 ${e.seen} 次，最近 ${e.lastSeen}：${e.meaning}`);
    console.log(`共 ${file.entries.length} 个${file.refreshedAt ? `；上一次自己刷新：${file.refreshedAt}` : ''}`);
} else if (command === 'add') {
    const [term, meaning] = positional;
    const example = one('--example') ?? '';
    if (!term || !meaning) { console.error('用法：add "<词>" "<一句话意思>" [--example "<例句>"]'); process.exit(2); }
    if ([...term].length < 2 || [...term].length > 12) { console.error('词要 2–12 个字'); process.exit(2); }
    if ([...meaning].length < 6 || [...meaning].length > 60) { console.error('意思要 6–60 个字'); process.exit(2); }
    if (MEME_BLOCK.test(term) || MEME_BLOCK.test(meaning) || MEME_BLOCK.test(example)) { console.error('带敏感词（政治、灾难、案件、低俗、骂人的一律不收）'); process.exit(2); }
    const file = loadMemes(path);
    const entry: MemeEntry = { term, meaning, example, confidence: 'high', firstSeen: today, lastSeen: today, seen: 1 };
    const rest = file.entries.filter(e => e.term !== term);
    saveMemes(path, { version: 1, ...(file.refreshedAt ? { refreshedAt: file.refreshedAt } : {}), entries: trimMemes([...rest, entry], new Date()) });
    console.log(`好了：「${term}」${meaning}`);
} else if (command === 'remove') {
    const [term] = positional;
    const file = loadMemes(path);
    if (!term || !file.entries.some(e => e.term === term)) { console.error(`库里没有「${term ?? ''}」`); process.exit(2); }
    saveMemes(path, { version: 1, ...(file.refreshedAt ? { refreshedAt: file.refreshedAt } : {}), entries: file.entries.filter(e => e.term !== term) });
    console.log(`删掉了「${term}」`);
} else {
    console.error('用法：list | add "<词>" "<意思>" [--example "<例句>"] | remove "<词>"   [--dir <数据目录>]');
    process.exit(2);
}
