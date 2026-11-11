// ADR 0212「看他的反应」用真实记录回放（只读，不写任何东西、不调模型、不发 QQ）。
// 只打印话题和次数、以及她那一刻会看到的那一行（那一行本身不带任何原话）；不打印聊天内容。
// 用法：node scripts/his-reactions-replay.mjs <数据目录> <他的 QQ> [档位=boyfriend] [人名,人名]
//   例：node scripts/his-reactions-replay.mjs runtime/bot-shadow <他的QQ号> boyfriend 高中闺蜜,大学闺蜜
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hisReactions, reactionsLine, reactionsLog, reactionTo } from '../packages/bot/src/proactive/his-reactions.ts';

const [dataDir, qq, tier = 'boyfriend', namesArg = ''] = process.argv.slice(2);
if (!dataDir || !qq) throw new Error('用法：node scripts/his-reactions-replay.mjs <数据目录> <他的 QQ> [档位] [人名,人名]');
const chatPath = join(dataDir, 'chats', `${qq}.jsonl`);
const statePath = join(dataDir, 'proactive', `${qq}-${tier}.json`);
for (const path of [chatPath, statePath]) if (!existsSync(path)) throw new Error(`找不到 ${path}`);
const history = readFileSync(chatPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const { records } = JSON.parse(readFileSync(statePath, 'utf8'));
const names = namesArg.split(',').map(s => s.trim()).filter(Boolean);

const sharing = new Set(['share', 'quiet', 'inner', 'news']);
const byId = new Map(history.map((m, i) => [m.messageId, i]));
const dist = {};
for (const r of records) {
    if (r.result !== 'sent' || !r.messageIds?.length || !sharing.has(r.occasion)) continue;
    const idx = r.messageIds.map(id => byId.get(id)).filter(i => i !== undefined);
    const key = idx.length ? `${r.occasion}:${reactionTo(history.slice(Math.max(...idx) + 1), Date.parse(history[Math.max(...idx)].time))}` : `${r.occasion}:(聊天记录里找不到)`;
    dist[key] = (dist[key] ?? 0) + 1;
}
console.log(`聊天 ${history.length} 条，主动记录 ${records.length} 条；她主动说自己的事、发出去了的，按「时机:他的反应」：${JSON.stringify(dist)}`);

const now = Date.now();
for (const daysAgo of [14, 7, 0]) {
    const at = now - daysAgo * 86_400_000;
    const stats = hisReactions(history.filter(m => Date.parse(m.time) <= at), records, at, names);
    console.log(`\n${new Date(at).toISOString().slice(0, 10)}：${reactionsLog(stats) || '（没有）'}`);
    console.log(`  她会看到：${reactionsLine(stats, at) ?? '（没有这一行：没有哪一类够 3 次、又明显偏向接着聊或回个嗯的，也没有他明说不想听的）'}`);
}
