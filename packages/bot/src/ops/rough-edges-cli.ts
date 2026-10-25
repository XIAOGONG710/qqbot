// node src/ops/rough-edges-cli.ts --chat <聊天 jsonl> [--chat …] [--human <真人聊天样本 jsonl> …] [--since ISO] [--until ISO]
// 用同一把尺子（src/rough-edges.ts）量毛刺：他本人的话 / 她的话 / 真人样本里的女生与男生。只出数字，不出原话。
// 真人样本 = exchange/research/2026-10-real-chat 里的 jsonl（每段有 her = 女方名字，turns[].who / bubbles）。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureEdges, perThousandChars, share, type EdgeStats } from '../rough-edges.ts';

const args = process.argv.slice(2);
const all = (name: string) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
const one = (name: string) => all(name).at(-1);
const abs = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);
const since = one('--since') ? Date.parse(one('--since')!) : 0;
const until = one('--until') ? Date.parse(one('--until')!) : Infinity;

const isNonText = (text: string) => /^\[(?:图片表情|表情包|sticker|图片|B 站私信)/.test(text) || /^<(?:sticker|photo)/.test(text) || /^她发了(?:个表情包|张照片)/.test(text) || /^https?:\/\//.test(text);

const his: string[] = [];
const hers: string[] = [];
for (const path of all('--chat')) {
    for (const line of readFileSync(abs(path), 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
            const row = JSON.parse(line) as { time?: string; role?: string; content?: unknown };
            const time = Date.parse(row.time ?? '') || 0;
            if (time < since || time > until || typeof row.content !== 'string' || isNonText(row.content.trim())) continue;
            if (row.role === 'user') his.push(row.content);
            else if (row.role === 'assistant') hers.push(row.content);
        } catch { /* 坏行跳过 */ }
    }
}
const girls: string[] = [];
const boys: string[] = [];
for (const path of all('--human')) {
    for (const line of readFileSync(abs(path), 'utf8').split(/\r?\n/).filter(Boolean)) {
        try {
            const seg = JSON.parse(line) as { relation?: string; her?: string; staged?: boolean; turns?: { who?: string; bubbles?: unknown }[] };
            if (seg.relation !== 'boyfriend' || seg.staged) continue;
            for (const turn of seg.turns ?? []) {
                const bubbles = Array.isArray(turn.bubbles) ? turn.bubbles.filter((b): b is string => typeof b === 'string' && b.trim() !== '' && !isNonText(b.trim())) : [];
                (turn.who === seg.her ? girls : boys).push(...bubbles);
            }
        } catch { /* 坏行跳过 */ }
    }
}

const pct = (value: number) => `${(100 * value).toFixed(1)}%`.padStart(6);
function row(name: string, texts: readonly string[]): EdgeStats {
    const stats = measureEdges(texts);
    console.log(`${name.padEnd(14)} 条数 ${String(stats.bubbles).padStart(5)}  平均字数 ${(stats.chars / Math.max(1, stats.bubbles)).toFixed(1).padStart(5)} | 占条数：语气字尾 ${pct(share(stats, 'tail'))}  停半拍 ${pct(share(stats, 'hesitation'))}  省略号 ${pct(share(stats, 'ellipsis'))}  笑 ${pct(share(stats, 'laugh'))}  任一 ${pct(share(stats, 'any'))} | 每千字：尾 ${perThousandChars(stats, 'tail').toFixed(1)}  任一 ${perThousandChars(stats, 'any').toFixed(1)}`);
    return stats;
}
if (his.length) row('他本人', his);
if (hers.length) row('她', hers);
if (girls.length) row('真人女生(样本)', girls);
if (boys.length) row('真人男生(样本)', boys);
