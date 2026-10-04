// 用法：npm run convert -w @qqbot/character-tools [-- --force]
//
// 把 characters/linmengyao/legacy/ 和 tiers.toml 转成 characters/linmengyao/st/ 下的角色卡和世界书，
// 每个档位一张卡 linmengyao-<档位>.json、一本场景世界书 linmengyao-scenes-<档位>.json（ADR 0003）。
// st/ 里的文件转换后可以在 SillyTavern 里继续改、再导出覆盖回来，
// 所以目标文件已存在且内容不同时默认拒绝覆盖，确认要重新生成时加 --force。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenes, readToml } from './legacy.ts';
import { parseTierConfig, personaToCard, skippedForReport } from './persona-to-card.ts';
import { scheduleForTier } from './schedule-to-card.ts';
import { scenesToLorebook } from './scenes-to-lorebook.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const legacyDir = join(characterDir, 'legacy');
const outDir = join(characterDir, 'st');

const force = process.argv.includes('--force');

const persona = readToml(join(legacyDir, 'persona.toml'));
const tiers = parseTierConfig(readToml(join(characterDir, 'tiers.toml')));
const scenes = readScenes(join(legacyDir, 'speech_library.toml'));
const scheduleToml = readToml(join(legacyDir, 'schedule.toml'));
const timetableToml = readToml(join(legacyDir, 'timetable.toml'));

const outputs: [file: string, data: unknown][] = [];
const summary: string[] = [];
for (const tier of tiers.tiers) {
    const world = `linmengyao-scenes-${tier.name}`;
    const lorebook = scenesToLorebook(scenes, tier.scenes, tier.dropScenes);
    const schedule = scheduleForTier(scheduleToml, timetableToml, tiers.schedule, tier.name);
    outputs.push([`linmengyao-${tier.name}.json`, personaToCard(persona, tiers, tier.name, { world, schedule })]);
    outputs.push([`${world}.json`, lorebook]);
    summary.push(`  ${tier.name}：世界书 ${Object.keys(lorebook.entries).length} 条场景（取 ${tier.scenes} 档${tier.dropScenes.length ? `，去掉 ${tier.dropScenes.join('、')}` : ''}）`);
}

mkdirSync(outDir, { recursive: true });
let refused = false;
for (const [file, data] of outputs) {
    const path = join(outDir, file);
    const text = JSON.stringify(data, null, 4) + '\n';
    const shown = relative(repoRoot, path);
    if (existsSync(path) && readFileSync(path, 'utf8') !== text && !force) {
        console.error(`跳过 ${shown}：已存在且内容不同（可能在 SillyTavern 里改过），确认覆盖请加 --force`);
        refused = true;
        continue;
    }
    writeFileSync(path, text);
    console.log(`写入 ${shown}`);
}

console.log('档位：');
for (const line of summary) console.log(line);
console.log('未转换：');
for (const [group, table] of Object.entries(skippedForReport)) {
    for (const [key, reason] of Object.entries(table)) console.log(`  ${group} ${key}：${reason}`);
}
if (refused) process.exitCode = 1;
