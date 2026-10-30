// 真模型试跑一次「每晚总结说话习惯」：她的话用管线版的回复（hers-A-full），他的话用 72 题的 stimulus，真人语料用其余的题。
// 用法：node speech-notes-dry.mjs <仓库根> <ctx-cases.json> <hers-A.json> [--limit N]
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, casesPath, hersPath] = process.argv.slice(2);
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 16;
const imp = rel => import(pathToFileURL(resolve(root, rel)).href);
const { reflectIfDue, loadNotesState, describeNotesForOwner } = await imp('packages/bot/src/language/speech-notes.ts');
const { loadConfig, cardKey } = await imp('packages/bot/src/platform/config.ts');
const { loadTierCard } = await imp('packages/bot/src/platform/contact.ts');
const { chatCompletion, unlimitedModelGuard } = await imp('packages/bot/src/language/llm.ts');
unlimitedModelGuard();
const config = loadConfig(resolve(root));
const llm = { ...config.llm, temperature: 0.9 };
const card = loadTierCard(config.characterCard, cardKey({ tier: 'boyfriend' }));

const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const hers = JSON.parse(readFileSync(hersPath, 'utf8'));
const used = cases.filter(item => hers[item.id]?.length).slice(0, limit);
const usedIds = new Set(used.map(item => item.id));
const NOW = new Date(2026, 9, 30, 23, 0, 0).getTime();
const history = [];
used.forEach((item, index) => {
    const at = NOW - (used.length - index) * 40 * 60_000;
    item.stimulus.forEach((text, i) => history.push({ time: new Date(at + i * 1000).toISOString(), role: 'user', content: text }));
    hers[item.id].forEach((text, i) => history.push({ time: new Date(at + 20_000 + i * 1000).toISOString(), role: 'assistant', content: text }));
});
const corpus = cases.filter(item => !usedIds.has(item.id) && item.human?.length).map(item => ({ id: item.id, source: 'dry', license: 'dry-run', said: item.stimulus.join(' '), replied: item.human }));

const dataDir = mkdtempSync(join(tmpdir(), 'speech-dry-'));
const logs = [];
const prompts = [];
const result = await reflectIfDue({
    dataDir, now: () => NOW,
    generate: async messages => { prompts.push(messages); return chatCompletion(llm, messages, { purpose: 'background' }); },
    history: () => history, corpus: () => corpus,
    persona: () => card.character.description.replace(/\{\{user\}\}/g, '宝宝').replace(/\{\{char\}\}/g, card.character.name).slice(0, 700),
    names: { char: card.character.name, user: '宝宝' }, log: line => logs.push(line),
    // 合成的反馈（只验证机制，不是他的真实偏好）：她管线回复里最长的 3 次标「像 AI」（第一条带理由）、最短的 2 次标「像真人」
    feedback: () => {
        const ranked = used.map(item => ({ item, n: hers[item.id].join('').length })).sort((a, b) => b.n - a.n);
        const entry = (x, label, i, why) => ({ at: NOW - i * 3_600_000, label, his: x.item.stimulus.slice(-2), hers: hers[x.item.id].slice(0, 4), ...(why ? { why } : {}) });
        return { ai: ranked.slice(0, 3).map((x, i) => entry(x, 'ai', i, i === 0 ? '太啰嗦了' : undefined)), human: ranked.slice(-2).map((x, i) => entry(x, 'human', i)) };
    },
});
console.log('history', history.length, 'corpus', corpus.length, 'model', llm.model);
console.log('结果', JSON.stringify({ ran: result.ran, error: result.error, lines: result.applied?.lines }, null, 1));
console.log('日志', logs.join('\n'));
console.log('\n' + describeNotesForOwner(loadNotesState(dataDir), NOW));
console.log('\n--- 提示词（user 部分前 1500 字）---\n' + prompts[0]?.[1]?.content.slice(0, 1500));
