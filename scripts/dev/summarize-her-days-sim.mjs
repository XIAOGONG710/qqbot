// ADR 0015：汇总一次“改前 / 改后”模拟器批次。只输出计数和平均值，不打印对话内容。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { bookMention, bookProgressAt, moodAt } from '../../packages/bot/src/her-days.ts';
import { inspectBookProgress, inspectSpeech, speechContext } from '../../packages/bot/src/speech-check.ts';
import { loadCharacterCard } from '../../packages/bot/src/st/card.ts';

const root = resolve(import.meta.dirname, '../..');
const batch = resolve(process.cwd(), process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(batch)) {
    console.error('用法：node scripts/dev/summarize-her-days-sim.mjs runtime/sim/<批次>');
    process.exit(2);
}

const files = walk(batch).filter(file => basename(file) === 'result.json');
const cards = new Map();
const speech = {
    first: { service: 0, ledger: 0, blame: 0, repeat: 0 },
    sent: { service: 0, ledger: 0, blame: 0, repeat: 0 },
};
const progress = { firstReplies: 0, firstIssues: 0, sentReplies: 0, sentIssues: 0 };
const moods = new Map();
let checksPassed = 0;
let checksFailed = 0;
let modelFailures = 0;
let firstReplies = 0;
let sentReplies = 0;
let sentBubbles = 0;
let rewrites = 0;

for (const file of files) {
    const result = JSON.parse(readFileSync(file, 'utf8'));
    const tier = result.scenario.tier;
    const card = cards.get(tier) ?? loadCharacterCard(join(root, `characters/linmengyao/st/linmengyao-${tier}.json`));
    cards.set(tier, card);
    checksPassed += result.checks?.passed ?? 0;
    checksFailed += result.checks?.failed ?? 0;
    const history = [];
    for (const step of result.steps ?? []) {
        modelFailures += (step.logs ?? []).filter(line => line.includes('回复失败：模型接口请求失败')).length;
        if (step.kind !== 'say') continue;
        for (const input of step.inputs ?? []) history.push({ role: 'user', content: input.text, time: new Date(input.time).toISOString() });
        const context = speechContext(history);
        const when = new Date(step.inputTime ?? step.time);
        const mention = bookMention(history, card.books);
        const books = card.books.map(book => ({ book, progress: bookProgressAt(card.schedule, book, when) }));

        for (const generation of step.generations ?? []) {
            if (!generation.raw) continue;
            firstReplies++;
            addSpeech(speech.first, generation.raw, context);
            const issues = inspectBookProgress(generation.raw, { books, focusIds: mention.bookIds });
            if (issues.length) progress.firstReplies++;
            progress.firstIssues += issues.length;
            rewrites += generation.rewrites?.length ?? 0;
        }

        const sent = (step.bubbles ?? []).map(item => item.text).join('\n');
        if (sent) {
            sentReplies++;
            sentBubbles += step.bubbles.length;
            addSpeech(speech.sent, sent, context);
            const issues = inspectBookProgress(sent, { books, focusIds: mention.bookIds });
            if (issues.length) progress.sentReplies++;
            progress.sentIssues += issues.length;
            const choice = moodAt(card.schedule, card.moods, when);
            if (choice) {
                const item = moods.get(choice.mood.name) ?? { replies: 0, bubbles: 0, chars: 0 };
                item.replies++;
                item.bubbles += step.bubbles.length;
                item.chars += [...sent.replaceAll('\n', '')].length;
                moods.set(choice.mood.name, item);
            }
        }
        for (const bubble of step.bubbles ?? []) history.push({ role: 'assistant', content: bubble.text, time: new Date(bubble.time).toISOString() });
    }
}

console.log(`批次 ${basename(batch)}：${files.length} 次运行；模型请求最终失败 ${modelFailures} 次`);
console.log(`检查：${checksPassed} 通过 / ${checksFailed} 不通过`);
console.log(`回复：第一版 ${firstReplies} 次；发出 ${sentReplies} 次、${sentBubbles} 个气泡`);
console.log(`第一版规则命中（按回复计）：助手腔 ${speech.first.service}、算账 ${speech.first.ledger}、怪他没说 ${speech.first.blame}、重复 ${speech.first.repeat}`);
console.log(`发出规则命中（按回复计）：助手腔 ${speech.sent.service}、算账 ${speech.sent.ledger}、怪他没说 ${speech.sent.blame}、重复 ${speech.sent.repeat}`);
console.log(`进度数字不一致：第一版 ${progress.firstReplies} 次回复 / ${progress.firstIssues} 个数字；发出 ${progress.sentReplies} 次回复 / ${progress.sentIssues} 个数字`);
console.log(`出口检查重写：${rewrites} 次`);
console.log('按当天心情分组的发出回复（心情还没接线的改前批次也按日期归组）：');
for (const [name, item] of [...moods].sort()) {
    console.log(`  ${name}：${item.replies} 次；平均 ${(item.bubbles / item.replies).toFixed(2)} 个气泡、${(item.chars / item.replies).toFixed(1)} 字`);
}

function addSpeech(counts, text, context) {
    const kinds = new Set(inspectSpeech(text, context).map(issue => issue.kind));
    for (const kind of kinds) counts[kind]++;
}

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });
}
