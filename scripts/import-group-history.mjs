#!/usr/bin/env node
// 把群里以前的聊天导进来（2026-11-14）：她进群前的那一段，得让她「看过」。
//
//   node scripts/import-group-history.mjs --group 555 --file 群聊.txt \
//        [--data-dir runtime/bot-shadow] [--self-qq 2561299676] [--self-name 繁星] [--dry-run]
//
// 认得的格式见 packages/bot/src/social/group-import.ts（一份文件可以混用）：
//   [2026-11-01 20:13] 老王: 在吗
//   老王：在吗
//   2026-11-01 20:13:02 老王(123456)  <- 下一行是内容（QQ 导出）
//   {"time":"2026-11-01T20:13:00+08:00","from":123456,"name":"老王","content":"在吗"}
//
// 导进去的记录标 history，只当上下文；不会触发她回话。同名同 QQ 的人在成员底账里合并。

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fillTimes, importGroupHistory, parseGroupHistory } from '../packages/bot/src/social/group-import.ts';

const { values } = parseArgs({
    options: {
        group: { type: 'string' },
        file: { type: 'string' },
        'data-dir': { type: 'string', default: 'runtime/bot-shadow' },
        'self-qq': { type: 'string' },
        'self-name': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
    },
});

const groupId = Number(values.group);
const file = values.file;
if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    console.error('用法：node scripts/import-group-history.mjs --group 群号 --file 记录文件 [--data-dir 目录] [--self-qq 号] [--self-name 名字] [--dry-run]');
    process.exit(2);
}
if (!file) {
    console.error('缺 --file（群聊记录文件）');
    process.exit(2);
}

const text = readFileSync(file, 'utf8');
const lines = fillTimes(parseGroupHistory(text), Date.now());
if (!lines.length) {
    console.error('一条都没认出来：看看格式（见脚本开头），或者先用几行试 --dry-run');
    process.exit(1);
}

const byName = new Map();
for (const line of lines) byName.set(line.name, (byName.get(line.name) ?? 0) + 1);
const others = new Set(lines.filter(line => !values['self-name'] || line.name !== values['self-name']).map(line => line.name));
console.log(`认出来 ${lines.length} 条，${others.size} 个人：${[...byName].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => `${name}×${count}`).join('、')}`);
console.log(`时间：${lines[0].time} ~ ${lines[lines.length - 1].time}`);

if (values['dry-run']) {
    console.log('试运行：没写文件。');
    process.exit(0);
}

const result = importGroupHistory({
    groupId,
    lines,
    dataDir: values['data-dir'],
    ...(values['self-qq'] ? { selfQq: Number(values['self-qq']) } : {}),
    ...(values['self-name'] ? { selfName: values['self-name'] } : {}),
});
console.log(`写进群 ${groupId}：${result.added} 条，认下 ${result.people} 个人（${values['data-dir']}/groups/${groupId}.jsonl 和 ${groupId}.people.json）`);
