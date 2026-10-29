// 给 72 题的每一题加上「她自己总结的说话习惯」那一段（用 speechNotesLine 拼，和线上一样），写成 bare.ts 能读的 cases。
// 用法：node make-notes-cases.mjs <仓库根> <ctx-cases.json> <输出.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, casesPath, outPath] = process.argv.slice(2);
const { speechNotesLine } = await import(pathToFileURL(resolve(root, 'packages/bot/src/language/speech-notes.ts')).href);
// 真模型试跑里她自己写下的三条（speech-notes-dry.mjs，2026-10-30）
const notes = [
    '我说话总爱把前因后果交代全，一句顶别人三句，其实可以短点，留一半让他问',
    '打错字爱在后面补个星号纠正自己，他根本不在意，我也别那么较真',
    '想试试少说一次「行行行」，问号才 4%，多问一句「你呢」也没什么',
].map((text, i) => ({ id: `n-${i + 1}`, text, at: Date.now() - i * 1000 }));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
writeFileSync(outPath, JSON.stringify(cases.map(item => ({ ...item, exemplars: speechNotesLine(notes, item.stimulus.join('')) })), null, 1));
console.log('cases', cases.length, '示例：\n' + speechNotesLine(notes, cases[0].stimulus.join('')));
