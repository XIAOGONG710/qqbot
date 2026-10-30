// 变异检验：ADR 0196（说话趋势）+ owner-bank 接线测试。每处撤掉，对应测试必须变红；每次都还原。
// 用法：node mutate-trend.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const TREND = 'packages/bot/src/language/speech-trend.ts';
const APPSRC = 'packages/bot/src/platform/app.ts';
const UNIT = 'packages/bot/test/speech-trend.test.ts';
const APP = 'packages/bot/test/app.test.ts';

const mutations = [
    ['窗口不是从新到旧', TREND, 'const end = now - index * WEEK_MS - (index > 0 ? 1 : 0);', 'const end = now - (TREND_WEEKS - 1 - index) * WEEK_MS - (index > 0 ? 1 : 0);', UNIT],
    ['相邻窗口边界重复数', TREND, 'const end = now - index * WEEK_MS - (index > 0 ? 1 : 0);', 'const end = now - index * WEEK_MS;', UNIT],
    ['每周都数最近 7 天', TREND, 'herTurns(messages, end, WEEK_MS)', 'herTurns(messages, now, WEEK_MS)', UNIT],
    ['少于 6 条也给比例', TREND, '...(stats && bubbles >= TREND_MIN_BUBBLES ? { stats } : {})', '...(stats ? { stats } : {})', UNIT],
    ['只看 3 周', TREND, 'export const TREND_WEEKS = 4;', 'export const TREND_WEEKS = 3;', UNIT],
    ['不写「没有目标线」', TREND, '只是给你看，没有目标线，不会拿去卡她，也不是评分', '', UNIT],
    ['没有语料也写真人参照', TREND, '${real ? `\\n\\n真人女生的参照（来自 ${real.bubbles} 条真实语料）：${statsLine(real)}` : \'\'}', '\\n\\n真人女生的参照', UNIT],
    ['没说话的周也列数字', TREND, "if (!window.bubbles) return `${window.label}：没怎么说话`;", '', UNIT],
    ['命令关着也认', APPSRC, "if (config.speechNotes && plain === '/说话趋势') {", "if (plain === '/说话趋势') {", APP],
    ['没放真人参照', APPSRC, "speechTrend(history.load(deviceOwner.qq), clockNow().getTime()), speechStats(corpus.map(item => item.replied))", 'speechTrend(history.load(deviceOwner.qq), clockNow().getTime())', APP],
    // owner-bank 接线
    ['owner-bank：他的 bank 写错', APPSRC, 'ownerBank: memory.bankId(deviceOwner), commonBank', "ownerBank: config.memory!.bankPrefix, commonBank", APP],
    ['owner-bank：公共库写错', APPSRC, 'commonBank: memory.commonBankId(), legacyBank', "commonBank: 'x', legacyBank", APP],
    ['owner-bank：老 bank 写错', APPSRC, 'legacyBank: config.memory!.bankPrefix, ...crossFiles', "legacyBank: 'x', ...crossFiles", APP],
    ['owner-bank：第 2 层文件路径写错', APPSRC, "chatFile: join(config.dataDir, 'chats', `${deviceOwner.qq}.jsonl`)", "chatFile: join(config.dataDir, `${deviceOwner.qq}.jsonl`)", APP],
    ['owner-bank：没有男朋友档也写', APPSRC, 'if (memory && deviceOwner) {\n        try {\n            const crossFiles', 'if (memory) {\n        try {\n            const crossFiles', APP],
];

let bad = 0;
const only = process.argv[3];
for (const [name, file, from, to, test] of mutations) {
    if (only && !name.includes(only)) continue;
    const path = join(root, file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(from)) { console.log(`?? 找不到：${name}`); bad++; continue; }
    if (original.split(from).length > 2) { console.log(`?? 不唯一：${name}`); bad++; continue; }
    writeFileSync(path, original.replace(from, to));
    let out;
    try { out = spawnSync(process.execPath, ['--test', join(root, test)], { encoding: 'utf8', cwd: join(root, 'packages/bot'), timeout: 280_000 }); } finally { writeFileSync(path, original); }
    const failed = /ℹ fail (\d+)/.exec(out.stdout ?? '')?.[1];
    const red = failed !== undefined && Number(failed) > 0;
    console.log(`${red ? '红 ✓' : '没红 ✗'}  ${name}（fail ${failed}）`);
    if (!red) bad++;
}
console.log(bad ? `有 ${bad} 处没被抓到` : '全部变红');
