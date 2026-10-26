// node src/ops/selfcheck-cli.ts [--chat <聊天 jsonl>]... [--limit 10] [--max-chars 25] [--card <角色卡 json>] [--prompt]
// 人格自检（ADR 0167）：最近十条回复对照设定卡，只出线索，不改任何东西、不发群。
//   --chat    聊天记录（可多次；默认 <数据目录>/chats/2260168937.jsonl，数据目录默认 runtime/bot）
//   --card    哪一档的卡（默认 characters/linmengyao/st/linmengyao-{tier}.json；--tier 选档，默认 boyfriend）
//   --prompt  额外打印交给模型逐条判断的提示词（需要模型时自己贴给任意模型；本工具不调模型、不花 token）
// 例子只截短、只取她的话；他的话一个字都不出现。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJudgePrompt, checkReplies, recentReplies } from '../selfcheck.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const all = (name: string) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
const one = (name: string) => all(name).at(-1);
const abs = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

const tier = one('--tier') ?? 'boyfriend';
const dir = resolve(repoRoot, one('--dir') ?? 'runtime/bot');
const chats = all('--chat').map(abs);
const paths = chats.length ? chats : [resolve(dir, `chats/2260168937.jsonl`)];
const cardPath = abs(one('--card') ?? resolve(repoRoot, `characters/linmengyao/st/linmengyao-${tier}.json`));
const limit = Number(one('--limit') ?? 10);
const maxChars = Number(one('--max-chars') ?? 25);

if (!existsSync(cardPath)) {
    console.error(`找不到角色卡：${cardPath}`);
    process.exit(2);
}
const card = JSON.parse(readFileSync(cardPath, 'utf8')) as { character: { name: string; description: string; personality: string; banned?: string[] } };
const rows: { role: string; content: string; time?: string }[] = [];
for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
            const row = JSON.parse(line) as { role?: unknown; content?: unknown; time?: unknown };
            if (typeof row.content === 'string') rows.push({ role: String(row.role ?? ''), content: row.content, ...(typeof row.time === 'string' ? { time: row.time } : {}) });
        } catch { /* 坏行跳过 */ }
    }
}
const replies = recentReplies(rows, Number.isSafeInteger(limit) && limit > 0 ? limit : 10);
if (!replies.length) {
    console.error('聊天记录里没找到可检查的回复（先确认 --chat 路径，或她还没说过话）');
    process.exit(1);
}

console.log(`人格自检：最近 ${replies.length} 条（卡：${card.character.name} / ${tier}）`);
const findings = checkReplies({ replies, banned: card.character.banned ?? [], maxChars });
if (!findings.length) {
    console.log('规则层：没发现明显跑偏（禁用词 / 助手腔 / 句号 / 长度 / 问句 / 开头重复都过）');
} else {
    for (const finding of findings) {
        console.log(`- ${finding.label}：${finding.count} 条${finding.examples.length ? `，例如 ${finding.examples.map(text => `「${text}」`).join('、')}` : ''}`);
    }
}
if (args.includes('--prompt')) {
    console.log('\n--- 交给模型的提示词（贴给任意模型，只要它按 JSON 回）---\n');
    console.log(buildJudgePrompt(card.character, replies));
}
