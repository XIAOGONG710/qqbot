// 真模型试跑「她夜里回想一天」：聊天用线上留下的真聊天（只读），日记用线上 diary.json（只读复制到临时目录）。
// 用法：QQBOT_CONFIG=<线上 config.json> node feeling-review-dry.mjs <仓库根> "2026-10-25T23:30" "2026-10-23T23:30" …
// 输出只打到屏幕，不写进仓库（里面有他们聊天的摘要）。
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, ...nights] = process.argv.slice(2);
const imp = rel => import(pathToFileURL(resolve(root, rel)).href);
const { reviewIfDue, loadReviewState, describeFeelingsForOwner, reviewMaterial } = await imp('packages/bot/src/emotion/feeling-review.ts');
const { loadConfig, cardKey } = await imp('packages/bot/src/platform/config.ts');
const { loadTierCard } = await imp('packages/bot/src/platform/contact.ts');
const { chatCompletion, unlimitedModelGuard } = await imp('packages/bot/src/language/llm.ts');
unlimitedModelGuard();
const config = loadConfig(resolve(root));
const llm = { ...config.llm, temperature: 0.9 };
const card = loadTierCard(config.characterCard, cardKey({ tier: 'boyfriend' }));
const owner = config.contacts.find(c => c.tier === 'boyfriend');
const others = config.contacts.filter(c => c.tier !== 'boyfriend').map(c => c.name);
const live = 'C:/Users/XG/Desktop/Project/qqbot/runtime/bot';
const rows = readFileSync(`${live}/chats/${owner.qq}.jsonl`, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return undefined; } }).filter(Boolean);
const diary = JSON.parse(readFileSync(`${live}/memory/diary.json`, 'utf8'));

for (const night of nights) {
    const now = new Date(night).getTime();
    const dataDir = mkdtempSync(join(tmpdir(), 'feel-review-'));
    const soulDir = mkdtempSync(join(tmpdir(), 'feel-soul-'));
    mkdirSync(join(dataDir, 'memory'), { recursive: true });
    writeFileSync(join(dataDir, 'memory', 'diary.json'), JSON.stringify({ written: diary.written, texts: diary.texts }));
    const logs = [];
    const prompts = [];
    const result = await reviewIfDue({
        dataDir, soulDir, now: () => now,
        generate: async messages => { prompts.push(messages); return chatCompletion(llm, messages, { purpose: 'background' }); },
        history: () => rows,
        persona: () => card.character.description.replace(/\{\{user\}\}/g, '宝宝').replace(/\{\{char\}\}/g, card.character.name).slice(0, 700),
        names: { char: card.character.name, user: '宝宝' }, others: () => others, existing: () => [], log: line => logs.push(line),
    });
    const material = reviewMaterial(rows, [], now);
    console.log(`\n===== ${night}（材料：${material.length} 条消息）=====`);
    console.log('结果', JSON.stringify({ ran: result.ran, error: result.error }), logs.join(' | '));
    for (const line of result.applied?.lines ?? []) console.log(' ·', line);
    const state = loadReviewState(dataDir);
    for (const item of state.items) console.log(`   依据 ${item.evidence.join('、')} → 感受时刻 ${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}`);
}
