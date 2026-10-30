// 回放：线上 10-22 → 10-26 的真聊天，按「一段聊天结束后半小时」逐段让她回想一次（真模型），共用一份状态。
// 然后看：这些记下的感受，在他每一句话之后她回他的那一刻，有多少会「明显」到进提示词（按种类）。
// 用法：QQBOT_CONFIG=<线上 config.json> node feeling-review-replay.mjs <仓库根> [起点 ISO] [终点 ISO]
// 输出只打到屏幕（里面有聊天摘要），不写进仓库。
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, fromIso = '2026-10-22T20:00', toIso = '2026-10-27T00:00'] = process.argv.slice(2);
const imp = rel => import(pathToFileURL(resolve(root, rel)).href);
const { reviewIfDue, loadReviewState, reviewAppraisals, SETTLE_MS } = await imp('packages/bot/src/emotion/feeling-review.ts');
const { feelingsAt, FEELING_NAME } = await imp('packages/bot/src/emotion/feelings.ts');
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
const from = new Date(fromIso).getTime(), to = new Date(toIso).getTime();

const dataDir = mkdtempSync(join(tmpdir(), 'feel-replay-'));
const soulDir = mkdtempSync(join(tmpdir(), 'feel-replay-soul-'));
mkdirSync(join(dataDir, 'memory'), { recursive: true });
writeFileSync(join(dataDir, 'memory', 'diary.json'), JSON.stringify({ written: diary.written, texts: diary.texts }));

// 一段聊天的结束 = 后面隔了 ≥45 分钟（或者记录到头了）
const times = rows.map(r => Date.parse(r.time)).filter(Number.isFinite).sort((a, b) => a - b);
const ends = times.filter((t, i) => (times[i + 1] === undefined || times[i + 1] - t >= 45 * 60_000) && t >= from && t <= to);
console.log('回放区间', fromIso, '→', toIso, '；消息', times.filter(t => t >= from && t <= to).length, '条；聊天段', ends.length, '段');

let calls = 0; let ran = 0; let failed = 0;
const history = () => rows.filter(r => Date.parse(r.time) <= currentNow);
let currentNow = 0;
for (const end of ends) {
    currentNow = end + SETTLE_MS + 60_000;
    const logs = [];
    const result = await reviewIfDue({
        dataDir, soulDir, now: () => currentNow,
        generate: async messages => { calls++; return chatCompletion(llm, messages, { purpose: 'background' }); },
        history, persona: () => card.character.description.replace(/\{\{user\}\}/g, '宝宝').replace(/\{\{char\}\}/g, card.character.name).slice(0, 700),
        names: { char: card.character.name, user: '宝宝' }, others: () => others, existing: () => [], log: line => logs.push(line),
    });
    if (!result.ran) continue;
    ran++; if (result.error) failed++;
    console.log(`\n[${new Date(currentNow).toLocaleString('zh-CN', { hour12: false })}]`, result.error ? `出错：${result.error}` : '');
    for (const line of result.applied?.lines ?? []) console.log('  ·', line);
}

const state = loadReviewState(dataDir);
console.log(`\n===== 汇总：模型调用 ${calls} 次，想了 ${ran} 次（失败 ${failed}）；最后留着 ${state.items.length} 条，放下 ${state.retired.length} 条，想记没成 ${state.rejected.length} 条 =====`);
const byKind = {};
for (const item of state.items) { const k = `${FEELING_NAME[item.kind]}·${item.strength === 2 ? '明显' : '小事'}${item.aboutHim ? '·因他' : ''}`; byKind[k] = (byKind[k] ?? 0) + 1; }
console.log('留着的种类', JSON.stringify(byKind));
for (const r of state.rejected) console.log('  没成：', r.reason);

// 他每说一句话，她回他的那一刻：只看这些回想出来的感受，有多少「明显」以上
const items = state.items;
const hisTurns = rows.filter(r => r.role === 'user' && Date.parse(r.time) >= from && Date.parse(r.time) <= to);
const tally = { 回他的轮次: hisTurns.length, 有明显感受的轮次: 0 };
const kinds = {};
for (const turn of hisTurns) {
    const at = Date.parse(turn.time) + 5_000;
    const visible = reviewAppraisals(items.filter(item => item.addedAt <= at));
    const felt = feelingsAt(visible, at).filter(f => f.level !== 'faint');
    if (felt.length) tally.有明显感受的轮次++;
    for (const f of felt) kinds[FEELING_NAME[f.kind]] = (kinds[FEELING_NAME[f.kind]] ?? 0) + 1;
}
console.log('他每句话后她回他的那一刻（只算回想出来的感受）：', JSON.stringify(tally), '各种类出现的轮次', JSON.stringify(kinds));
