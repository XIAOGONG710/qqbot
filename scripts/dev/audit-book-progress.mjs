// ADR 0015：把书的进度数字规则只读跑过现有模拟器和 QQ 聊天材料。
// 只打印分档计数和命中的数字，不打印聊天内容、QQ 号；低档位命中会列出模拟器文件或「QQ 聊天」供人工核对。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { bookProgressAt } from '../../packages/bot/src/life/her-days.ts';
import { inspectBookProgress } from '../../packages/bot/src/language/speech-check.ts';
import { loadCharacterCard } from '../../packages/bot/src/st/card.ts';

const root = resolve(import.meta.dirname, '../..');
const tiers = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger', 'unlisted'];
const cards = new Map(tiers.map(tier => [tier, loadCharacterCard(join(root, `characters/linmengyao/st/linmengyao-${tier}.json`))]));
const counts = new Map();
const review = [];

const add = (tier, stage, text, time, where) => {
    const card = cards.get(tier);
    if (!card?.books.length || !text) return;
    const day = new Date(time);
    const books = card.books.map(book => ({ book, progress: bookProgressAt(card.schedule, book, day) }));
    for (const issue of inspectBookProgress(text, { books })) {
        const key = `${tier}\t${stage}\t${issue.kind}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (tier === 'classmate' || tier === 'stranger' || tier === 'unlisted') {
            review.push({ tier, stage, where, book: issue.bookId, said: issue.said, expected: issue.expected, unit: issue.unit });
        }
    }
};

const walk = dir => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
}) : [];

let resultRuns = 0;
for (const file of walk(join(root, 'runtime/sim')).filter(file => basename(file) === 'result.json')) {
    const result = JSON.parse(readFileSync(file, 'utf8'));
    const tier = result.scenario?.tier;
    if (!tiers.includes(tier)) continue;
    resultRuns++;
    for (const [index, step] of (result.steps ?? []).entries()) {
        const time = step.time ?? Date.parse(result.scenario.start);
        for (const generation of step.generations ?? []) add(tier, 'first', generation.raw, generation.time ?? time, `${file.replace(root, '').replaceAll('\\', '/')}:step${index + 1}`);
    }
}

let simRuns = 0;
let simReplies = 0;
for (const file of walk(join(root, 'runtime/sim')).filter(file => /[\\/]chats[\\/][^\\/]+\.jsonl$/.test(file))) {
    const parts = relative(join(root, 'runtime/sim'), file).split(/[\\/]/);
    const scenarioName = parts[1];
    const scenarioFile = scenarioName ? join(root, 'packages/bot/sim', `${scenarioName}.json`) : '';
    const resultFile = join(dirname(file), '..', 'result.json');
    const tier = scenarioFile && existsSync(scenarioFile)
        ? JSON.parse(readFileSync(scenarioFile, 'utf8')).tier
        : existsSync(resultFile)
            ? JSON.parse(readFileSync(resultFile, 'utf8')).scenario?.tier
            : undefined;
    if (!tiers.includes(tier)) continue;
    simRuns++;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const message = JSON.parse(line);
            if (message.role !== 'assistant') continue;
            simReplies++;
            add(tier, 'sent', message.content, Date.parse(message.time), file.replace(root, '').replaceAll('\\', '/'));
        } catch {
            // 写到一半的末行和 ChatHistory 一样跳过。
        }
    }
}

let tierRecords = {};
const tierFile = join(root, 'runtime/bot/tiers.json');
if (existsSync(tierFile)) tierRecords = JSON.parse(readFileSync(tierFile, 'utf8'));
let qqReplies = 0;
for (const file of walk(join(root, 'runtime/bot/chats')).filter(file => file.endsWith('.jsonl'))) {
    const name = basename(file, '.jsonl');
    const namedTier = tiers.find(tier => name.includes(`-${tier}-`));
    const qq = /^\d+$/.test(name) ? name : name.match(/^(\d+)-/)?.[1];
    const record = qq ? tierRecords[qq] : undefined;
    const tier = namedTier ?? (typeof record === 'string' ? record : record?.tier);
    if (!tiers.includes(tier)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
            const message = JSON.parse(line);
            if (message.role !== 'assistant') continue;
            qqReplies++;
            add(tier, 'sent', message.content, Date.parse(message.time), 'QQ 聊天（已隐藏号码）');
        } catch {
            // 写到一半的末行和 ChatHistory 一样跳过。
        }
    }
}

console.log(`材料：模拟器 ${simRuns} 次运行、${simReplies} 行她说的（其中 ${resultRuns} 次有第一版记录）；QQ ${qqReplies} 行她说的`);
if (!counts.size) {
    console.log('进度数字规则：0 次命中');
} else {
    console.log('进度数字规则命中（档位 / 第一版或发出 / 进度或总量）：');
    for (const [key, count] of [...counts].sort()) console.log(`  ${key.replaceAll('\t', ' / ')}：${count}`);
}
console.log(`同学 / 陌生人 / 名单外待人工核对：${review.length} 次`);
for (const item of review) console.log(`  ${item.tier} / ${item.stage} / ${item.book}：${item.said}${item.unit}，资料 ${item.expected}${item.unit}；${item.where}`);
