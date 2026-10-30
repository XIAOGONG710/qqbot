// 变异检验：ADR 0194 补充——桌面上的她也看得到（INSIGHTS.json：QQ 写、插件读）。每处撤掉，对应测试必须变红；每次都还原。
// 用法：node mutate-insights-desktop.mjs <仓库根>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv[2];
const MOD = 'packages/bot/src/life/diary-insights.ts';
const UNIT = 'packages/bot/test/diary-insights.test.ts';
const APPSRC = 'packages/bot/src/platform/app.ts';
const APP = 'packages/bot/test/app.test.ts';
const PLUGIN = 'dsh-plugins/dsh-linmengyao-memory/index.js';
const PTEST = 'packages/bot/test/soul-plugin.test.ts';

const mutations = [
    // ── QQ 这边写 ──
    ['太常见的二字词也带出去', MOD, '[...gramSet(note)].filter(gram => !COMMON_GRAMS.has(gram))', '[...gramSet(note)]', UNIT],
    ['每次都重写', MOD, 'if (isObject(current) && current.kind === INSIGHTS_EXPORT_KIND && JSON.stringify(current.notes) === JSON.stringify(next)) {', 'if (false) {', UNIT],
    ['时间戳不刷新', MOD, 'if (Number.isFinite(written) && now - written < INSIGHTS_REFRESH_MS && written <= now) return false;', 'if (Number.isFinite(written)) return false;', UNIT],
    ['时间在未来也不重写', MOD, 'now - written < INSIGHTS_REFRESH_MS && written <= now', 'now - written < INSIGHTS_REFRESH_MS', UNIT],
    ['不限 12 条', MOD, 'notes.slice(-MAX_ACTIVE).map(note => ({ text: clip(note.text, INSIGHT_MAX)', 'notes.map(note => ({ text: clip(note.text, INSIGHT_MAX)', UNIT],
    ['启动时不写', APPSRC, '        exportInsights();\n        const timer = setInterval(tick, 30 * 60_000);', '        const timer = setInterval(tick, 30 * 60_000);', APP],
    ['想完不写', APPSRC, '.finally(() => { busy = false; exportInsights(); });', '.finally(() => { busy = false; });', APP],
    // ── 桌面这边读 ──
    ['不看是不是桌面上的回合', PLUGIN, "  if (channel() !== 'desktop') return ''\n  const target = bigramsOf(query)", '  const target = bigramsOf(query)', PTEST],
    ['过期也用', PLUGIN, 'now - at > cfg.insightsStaleMs', 'false', PTEST],
    ['不认标记', PLUGIN, "if (!data || data.kind !== 'qq-diary-insights') return []", 'if (!data) return []', PTEST],
    ['未来的时间也信', PLUGIN, ' || at > now + 60_000) return []\n    return (Array.isArray(data.notes)', ') return []\n    return (Array.isArray(data.notes)', PTEST],
    ['绊线失效', PLUGIN, "if (!text || soulTripwire(text) || /<<|>>/.test(text)) return []", "if (!text) return []", PTEST],
    ['标记不拦', PLUGIN, "if (!text || soulTripwire(text) || /<<|>>/.test(text)) return []", "if (!text || soulTripwire(text)) return []", PTEST],
    ['不限 12 条', PLUGIN, '.slice(-12).flatMap((item) => {', '.flatMap((item) => {', PTEST],
    ['原文不截', PLUGIN, ".replace(/\\s+/g, ' ').trim().slice(0, 70)", ".replace(/\\s+/g, ' ').trim()", PTEST],
    ['没聊到也放', PLUGIN, '    .filter((item) => item.score > 0)\n    .sort((a, b) => b.score - a.score || b.note.at - a.note.at)', '    .sort((a, b) => b.score - a.score || b.note.at - a.note.at)', PTEST],
    ['不限 3 条', PLUGIN, 'max = 3) {\n  if (channel()', 'max = 99) {\n  if (channel()', PTEST],
    ['排序不看重叠', PLUGIN, '.sort((a, b) => b.score - a.score || b.note.at - a.note.at)', '.sort((a, b) => b.note.at - a.note.at)', PTEST],
    ['没放进提示词', PLUGIN, '              soul ? `[你现在的自我]\\n${soul}` : \'\',\n              insights,', '              soul ? `[你现在的自我]\\n${soul}` : \'\',', PTEST],
    ['提示词里提日记', PLUGIN, '[你对自己的了解（是你自己慢慢发现的', '[你翻自己日记时发现的自己（是你自己慢慢发现的', PTEST],
];

let bad = 0;
for (const [name, file, from, to, test] of mutations) {
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
