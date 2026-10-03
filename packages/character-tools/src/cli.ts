// 用法：npm run convert -w @qqbot/character-tools [-- --force]
//
// 把 characters/linmengyao/legacy/ 转成 characters/linmengyao/st/ 下的角色卡和世界书。
// st/ 里的文件转换后可以在 SillyTavern 里继续改、再导出覆盖回来，
// 所以目标文件已存在且内容不同时默认拒绝覆盖，确认要重新生成时加 --force。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenes, readToml } from './legacy.ts';
import { personaToCard, skippedForReport } from './persona-to-card.ts';
import { scenesToLorebook } from './scenes-to-lorebook.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const legacyDir = join(characterDir, 'legacy');
const outDir = join(characterDir, 'st');

// M1 只有男朋友一个聊天对象
const TIER = 'boyfriend';
const WORLD_NAME = `linmengyao-scenes-${TIER}`;

const force = process.argv.includes('--force');

const card = personaToCard(readToml(join(legacyDir, 'persona.toml')), { world: WORLD_NAME });
const lorebook = scenesToLorebook(readScenes(join(legacyDir, 'speech_library.toml')), TIER);

const outputs: [file: string, data: unknown][] = [
    ['linmengyao.json', card],
    [`${WORLD_NAME}.json`, lorebook],
];

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

console.log(`世界书 ${WORLD_NAME}：${Object.keys(lorebook.entries).length} 条场景（档位 ${TIER}）`);
console.log('未转换：');
for (const [group, table] of Object.entries(skippedForReport)) {
    for (const [key, reason] of Object.entries(table)) console.log(`  ${group} ${key}：${reason}`);
}
if (refused) process.exitCode = 1;
