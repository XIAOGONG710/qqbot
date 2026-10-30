// 变异检验：「桌面读她在 QQ 写的日记」那处修复。用法：node mutate-ownerdoc.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const SRC = 'dsh-plugins/dsh-linmengyao-memory/index.js';
const TEST = 'packages/bot/test/soul-plugin.test.ts';
const mutations = [
    ['一律不取（回到原来）', 'return Boolean(mine && ownerHashValue && mine[1] === ownerHashValue)', 'return false'],
    ['不比哈希（别人的也取）', 'return Boolean(mine && ownerHashValue && mine[1] === ownerHashValue)', 'return Boolean(mine)'],
    ['不认 self:（只认 diary-self:）', '/^(?:diary-self|self):([0-9a-f]{16}):/', '/^(?:diary-self):([0-9a-f]{16}):/'],
    ['不认 diary-self:（只认 self:）', '/^(?:diary-self|self):([0-9a-f]{16}):/', '/^(?:self):([0-9a-f]{16}):/'],
    ['前缀不锚定', '/^(?:diary-self|self):([0-9a-f]{16}):/', '/(?:diary-self|self):([0-9a-f]{16}):/'],
    ['召回时没把他的哈希传进去', 'herOwnCommonDoc(item.documentId, mineHash)', 'herOwnCommonDoc(item.documentId)'],
    ['没有他的 bank 也取（不知道他是谁时）', 'return Boolean(mine && ownerHashValue && mine[1] === ownerHashValue)', 'return Boolean(mine && (!ownerHashValue || mine[1] === ownerHashValue))'],
    ['以前的三种不认了', "if (/^(diary|week|phase):/.test(id)) return true", 'if (false) return true'],
];

const path = join(root, SRC);
let bad = 0;
for (const [name, from, to] of mutations) {
    const original = readFileSync(path, 'utf8');
    if (!original.includes(from)) { console.log(`?? 找不到：${name}`); bad++; continue; }
    if (original.split(from).length > 2) { console.log(`?? 不唯一：${name}`); bad++; continue; }
    writeFileSync(path, original.replace(from, to));
    let out;
    try { out = spawnSync(process.execPath, ['--test', join(root, TEST)], { encoding: 'utf8', cwd: join(root, 'packages/bot'), timeout: 120_000 }); } finally { writeFileSync(path, original); }
    const failed = /ℹ fail (\d+)/.exec(out.stdout ?? '')?.[1];
    const red = failed !== undefined && Number(failed) > 0;
    console.log(`${red ? '红 ✓' : '没红 ✗'}  ${name}（fail ${failed}）`);
    if (!red) bad++;
}
console.log(bad ? `有 ${bad} 处没被抓到` : '全部变红');
