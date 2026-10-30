// 真模型试跑一次「她翻自己的日记写对自己的认识」：日记用线上留下的 23 篇真日记（只读，复制到临时目录），模型是线上配置里的那个。
// 用法：QQBOT_CONFIG=<线上 config.json> QQBOT_LLM_API_KEY=… node diary-insights-dry.mjs <仓库根> <线上 diary.json> [--runs N]
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, liveDiary] = process.argv.slice(2);
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1;
const imp = rel => import(pathToFileURL(resolve(root, rel)).href);
const { reflectIfDue, loadInsightsState, describeInsightsForOwner, readDiaries, fitEntries } = await imp('packages/bot/src/life/diary-insights.ts');
const { loadConfig, cardKey } = await imp('packages/bot/src/platform/config.ts');
const { loadTierCard } = await imp('packages/bot/src/platform/contact.ts');
const { chatCompletion, unlimitedModelGuard } = await imp('packages/bot/src/language/llm.ts');
unlimitedModelGuard();
const config = loadConfig(resolve(root));
const llm = { ...config.llm, temperature: 0.9 };
const card = loadTierCard(config.characterCard, cardKey({ tier: 'boyfriend' }));
const others = config.contacts.filter(c => c.tier !== 'boyfriend').map(c => c.name);

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime();
const live = JSON.parse(readFileSync(liveDiary, 'utf8'));

for (let run = 1; run <= runs; run++) {
    const dataDir = mkdtempSync(join(tmpdir(), 'insights-dry-'));
    const soulDir = mkdtempSync(join(tmpdir(), 'insights-soul-'));
    mkdirSync(join(dataDir, 'memory'), { recursive: true });
    writeFileSync(join(dataDir, 'memory', 'diary.json'), JSON.stringify({ written: live.written, texts: live.texts }));
    const logs = [];
    const prompts = [];
    const shown = fitEntries(readDiaries({ soulDir, dataDir }, NOW));
    const result = await reflectIfDue({
        dataDir, soulDir, now: () => NOW,
        generate: async messages => { prompts.push(messages); return chatCompletion(llm, messages, { purpose: 'background' }); },
        history: () => [],
        persona: () => card.character.description.replace(/\{\{user\}\}/g, '宝宝').replace(/\{\{char\}\}/g, card.character.name).slice(0, 700),
        names: { char: card.character.name, user: '宝宝' }, others: () => others, log: line => logs.push(line),
    });
    console.log(`\n===== 第 ${run} 次 =====`);
    console.log('翻了', shown.length, '篇，日期', shown[0]?.date, '→', shown.at(-1)?.date, '| model', llm.model);
    console.log('结果', JSON.stringify({ ran: result.ran, error: result.error, lines: result.applied?.lines }, null, 1));
    console.log('日志', logs.join('\n'));
    console.log('\n' + describeInsightsForOwner(loadInsightsState(dataDir), NOW));
    if (run === 1) console.log('\n--- 提示词（user 部分最后 1100 字）---\n' + prompts[0]?.[1]?.content.slice(-1100));
}
