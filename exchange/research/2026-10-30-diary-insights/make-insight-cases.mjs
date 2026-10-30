// 给 72 题的每一题加上「她翻日记时发现的自己」那一段（用 insightsLine 拼，和线上一样），写成 bare.ts 能读的 cases。
// 用法：node make-insight-cases.mjs <仓库根> <ctx-cases.json> <输出.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, casesPath, outPath] = process.argv.slice(2);
const { insightsLine } = await import(pathToFileURL(resolve(root, 'packages/bot/src/life/diary-insights.ts')).href);
// 真模型试跑里她自己写下的两条（diary-insights-dry.mjs 第 1 次，2026-10-30）
const notes = [
    '作业总拖到要交的前一晚才动手，熬到很晚才写完，眼睛都熬得发酸。',
    '有些日子会没来由地一直想笑、话也格外多，自己都说不上为什么。',
].map((text, i) => ({ id: `i-${i + 1}`, text, at: Date.now() - i * 1000, dates: ['2026-10-12', '2026-10-25'] }));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
writeFileSync(outPath, JSON.stringify(cases.map(item => ({ ...item, exemplars: insightsLine(notes, item.stimulus.join('')) })), null, 1));
console.log('cases', cases.length, '示例：\n' + insightsLine(notes, cases[0].stimulus.join('')));
