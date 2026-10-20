// node src/ops/humanness-cli.ts --chat <聊天 jsonl> [--chat …] [--human <真人聊天样本 jsonl> …] [--since ISO] [--until ISO] [--save 模型.json]
//                              [--model 模型.json --score <聊天 jsonl> …]
// 「像不像真人」检测器的训练和打分（src/humanness.ts）。只出数字和特征名，不出任何原话。
// 真人样本 = 聊天记录里他自己发的话（同一个场景里最真的真人）+ 可选的真人聊天样本（exchange/research/2026-10-real-chat 里的气泡）；
// 「她」= 聊天记录里 assistant 的话（--since / --until 可以只取某一段，比如改之前和改之后分开量）。
// --score：用已经训练好的模型（--model）给别的聊天记录里她的话打分——改前改后用同一把尺子才能比（模拟器的输出在 runtime/sim/…/chats/*.jsonl，格式相同）。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auc, bubbleFeatures, FEATURE_NAMES, featureEffects, humanProbability, trainModel, type Model } from '../humanness.ts';

const args = process.argv.slice(2);
const all = (name: string) => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
const one = (name: string) => all(name).at(-1);
const abs = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

const isNonText = (text: string) => /^\[(?:图片表情|表情包|sticker|图片|B 站私信)/.test(text) || /^<sticker/.test(text) || /^https?:\/\//.test(text.trim());
const clean = (text: string) => text.trim();

interface Row { time: number; role: 'user' | 'assistant'; text: string }

function readChat(path: string): Row[] {
    return readFileSync(abs(path), 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try {
            const row = JSON.parse(line) as { time?: string; role?: string; content?: unknown };
            if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string' || isNonText(row.content)) return [];
            const text = clean(row.content);
            const role: Row['role'] = row.role;
            return text ? [{ time: Date.parse(row.time ?? '') || 0, role, text }] : [];
        } catch { return []; }
    }).sort((a, b) => a.time - b.time);
}

function readHuman(path: string): string[] {
    return readFileSync(abs(path), 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try {
            const row = JSON.parse(line) as { turns?: { bubbles?: unknown }[] };
            return (row.turns ?? []).flatMap(turn => (Array.isArray(turn.bubbles) ? turn.bubbles.filter((bubble): bubble is string => typeof bubble === 'string' && bubble.trim() !== '') : []));
        } catch { return []; }
    });
}

const since = one('--since') ? Date.parse(one('--since')!) : 0;
const until = one('--until') ? Date.parse(one('--until')!) : Infinity;
const quantile = (values: number[], p: number) => { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!; };
const length = (text: string) => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

/** 一组话的形状：字数分布和极短 / 长的占比 */
function shape(texts: string[]): string {
    const lengths = texts.map(length);
    return `n=${texts.length}  字数 中位 ${quantile(lengths, 0.5)} p25 ${quantile(lengths, 0.25)} p75 ${quantile(lengths, 0.75)} p90 ${quantile(lengths, 0.9)}  ≤4 字 ${pct(lengths.filter(n => n <= 4).length, lengths.length)}  ≥15 字 ${pct(lengths.filter(n => n >= 15).length, lengths.length)}`;
}

function loadModel(path: string): Model { return JSON.parse(readFileSync(abs(path), 'utf8')) as Model; }

// ───────── 打分模式 ─────────
if (one('--model') && all('--score').length) {
    const model = loadModel(one('--model')!);
    const report = (label: string, hers: string[]) => {
        const probs = hers.map(text => humanProbability(model, text));
        const mean = probs.reduce((sum, p) => sum + p, 0) / (probs.length || 1);
        console.log(`${label}\n  她：${shape(hers)}\n  P(真人) 平均 ${mean.toFixed(3)}  中位 ${quantile(probs, 0.5).toFixed(3)}  >0.5 的占 ${pct(probs.filter(p => p > 0.5).length, probs.length)}`);
    };
    const together: string[] = [];
    for (const path of all('--score')) {
        const hers = readChat(path).filter(row => row.role === 'assistant' && row.time >= since && row.time <= until).map(row => row.text);
        together.push(...hers);
        if (!args.includes('--total-only')) report(path, hers);
    }
    if (all('--score').length > 1 || args.includes('--total-only')) report(`合计（${all('--score').length} 个文件）`, together);
    process.exit(0);
}

// ───────── 训练 + 评估 ─────────
const chatRows = all('--chat').flatMap(readChat);
const hers = chatRows.filter(row => row.role === 'assistant' && row.time >= since && row.time <= until).map(row => row.text);
const hisOwn = chatRows.filter(row => row.role === 'user').map(row => row.text);
const sampled = all('--human').flatMap(readHuman);
const humans = [...hisOwn, ...sampled];
if (hers.length < 30 || humans.length < 30) {
    console.error(`样本太少（她 ${hers.length}、真人 ${humans.length}），至少各 30 条`);
    process.exit(2);
}

console.log('═ 样本');
console.log(`她：${shape(hers)}`);
console.log(`真人（他自己的话 ${hisOwn.length} + 真人聊天样本 ${sampled.length}）：${shape(humans)}`);

type Item = { x: number[]; y: 0 | 1; length: number };
const toItems = (texts: string[], y: 0 | 1): Item[] => texts.map(text => ({ x: bubbleFeatures(text), y, length: length(text) }));
const items = [...toItems(humans, 1), ...toItems(hers, 0)];
// 两类的总权重一样，免得样本多的一类占便宜
const weightOf = (y: 0 | 1) => (y === 1 ? 0.5 / humans.length : 0.5 / hers.length) * items.length;

/** 连续分 5 块的交叉验证（同一类按原来的顺序切，相邻的话不会一边训练一边测试）；features 可以去掉一部分 */
function crossValidate(data: Item[], drop: ReadonlySet<number> = new Set(), balance = true): { auc: number; oof: Map<Item, number> } {
    const folds = 5;
    const byClass = [0, 1].map(y => data.filter(item => item.y === y));
    const part = (list: Item[], fold: number) => list.filter((_, i) => Math.floor((i * folds) / list.length) === fold);
    const mask = (x: number[]) => x.map((value, j) => (drop.has(j) ? 0 : value));
    const oof = new Map<Item, number>();
    const scored: { score: number; y: 0 | 1 }[] = [];
    for (let fold = 0; fold < folds; fold++) {
        const test = byClass.flatMap(list => part(list, fold));
        const testSet = new Set(test);
        const train = data.filter(item => !testSet.has(item));
        const counts = [train.filter(item => item.y === 0).length, train.filter(item => item.y === 1).length];
        const model = trainModel(train.map(item => ({ x: mask(item.x), y: item.y, w: balance && counts[item.y] ? (0.5 * train.length) / counts[item.y]! : 1 })));
        for (const item of test) {
            const x = mask(item.x);
            const p = 1 / (1 + Math.exp(-(model.bias + x.reduce((sum, value, j) => sum + ((value - model.mean[j]!) / model.std[j]!) * model.weights[j]!, 0))));
            oof.set(item, p);
            scored.push({ score: p, y: item.y });
        }
    }
    return { auc: auc(scored), oof };
}

const lengthFeatures = new Set(FEATURE_NAMES.map((name, j) => (name.startsWith('len_') ? j : -1)).filter(j => j >= 0));
console.log('\n═ 区分得开吗（5 折交叉验证的 AUC：0.5 = 分不开，1 = 一眼分开）');
const full = crossValidate(items);
console.log(`全部特征：${full.auc.toFixed(3)}`);
const herOof = items.filter(item => item.y === 0).map(item => full.oof.get(item)!);
const humanOof = items.filter(item => item.y === 1).map(item => full.oof.get(item)!);
console.log(`  她的话被判成真人（P>0.5）：${pct(herOof.filter(p => p > 0.5).length, herOof.length)}；真人的话被判成真人：${pct(humanOof.filter(p => p > 0.5).length, humanOof.length)}`);
console.log(`去掉字数特征：${crossValidate(items, lengthFeatures).auc.toFixed(3)}（只看标点 / 语气词 / 结构）`);

// 字数配平：每个字数段里两边取一样多，再比——剩下的差别就不是长短了
const bins: [number, number][] = [[1, 4], [5, 8], [9, 14], [15, 24], [25, 999]];
const matched: Item[] = [];
for (const [lo, hi] of bins) {
    const a = items.filter(item => item.y === 1 && item.length >= lo && item.length <= hi);
    const b = items.filter(item => item.y === 0 && item.length >= lo && item.length <= hi);
    const n = Math.min(a.length, b.length);
    matched.push(...a.slice(0, n), ...b.slice(0, n));
}
console.log(`字数配平后（${bins.map(([lo, hi]) => `${lo}–${hi}`).join(' / ')} 字各取一样多，共 ${matched.length} 条）：${crossValidate(matched, lengthFeatures, false).auc.toFixed(3)}`);
console.log('各字数段里两边各有多少（真人 / 她）：' + bins.map(([lo, hi]) => `${lo}–${hi}字 ${items.filter(i => i.y === 1 && i.length >= lo && i.length <= hi).length}/${items.filter(i => i.y === 0 && i.length >= lo && i.length <= hi).length}`).join('，'));

// 全量训练，报哪些特征最露馅
const model = trainModel(items.map(item => ({ x: item.x, y: item.y, w: weightOf(item.y) })));
const effects = featureEffects(model);
console.log('\n═ 最露馅的写法（权重 < 0：有它更像她 / AI）');
for (const { name, weight } of effects.filter(effect => effect.weight < 0).slice(0, 10)) console.log(`  ${weight.toFixed(2).padStart(6)}  ${name}  她 ${meanOf(hers, name)}  真人 ${meanOf(humans, name)}`);
console.log('═ 最像真人的写法（权重 > 0）');
for (const { name, weight } of effects.filter(effect => effect.weight > 0).slice(0, 8)) console.log(`  ${weight.toFixed(2).padStart(6)}  ${name}  她 ${meanOf(hers, name)}  真人 ${meanOf(humans, name)}`);

function meanOf(texts: string[], name: string): string {
    const j = FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    const values = texts.map(text => bubbleFeatures(text)[j]!);
    return (values.reduce((sum, value) => sum + value, 0) / (values.length || 1)).toFixed(2);
}

if (one('--save')) {
    writeFileSync(abs(one('--save')!), JSON.stringify(model, null, 2) + '\n');
    console.log(`\n模型已存到 ${one('--save')}（只有特征权重，不含原话）`);
}
