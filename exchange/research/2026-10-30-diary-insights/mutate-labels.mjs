// 变异检验：QQ 侧 diary-self / self 的披露标签。用法：node mutate-labels.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const SRC = 'packages/bot/src/memory/long-term.ts';
const TEST = 'packages/bot/test/memory.test.ts';
const mutations = [
    ['整段不认（回到原来）', 'const note = SELF_NOTE_ID.exec(id);', 'const note = null as RegExpExecArray | null;'],
    ['自己的也按别人的标', "return note[1] === this.#hash(listener) ? ownNoteLabel() : sourceLabel(writer, listener);", 'return sourceLabel(writer, listener);'],
    ['别人的也标「你自己记下的」', "return note[1] === this.#hash(listener) ? ownNoteLabel() : sourceLabel(writer, listener);", 'return ownNoteLabel();'],
    ['名单里没有的人也标可明说', "if (!writer) return '不能说·来源不明';", "if (!writer) return ownNoteLabel();"],
    ['前缀不锚定', "export const SELF_NOTE_ID = /^(?:diary-self|self):([0-9a-f]{16}):/;", "export const SELF_NOTE_ID = /(?:diary-self|self):([0-9a-f]{16}):/;"],
    ['不认 self:', "export const SELF_NOTE_ID = /^(?:diary-self|self):([0-9a-f]{16}):/;", "export const SELF_NOTE_ID = /^(?:diary-self):([0-9a-f]{16}):/;"],
    ['不认 diary-self:', "export const SELF_NOTE_ID = /^(?:diary-self|self):([0-9a-f]{16}):/;", "export const SELF_NOTE_ID = /^(?:self):([0-9a-f]{16}):/;"],
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
