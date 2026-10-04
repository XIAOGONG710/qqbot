// 用法：npm run convert -w @qqbot/character-tools [-- --force]
//      （或 node packages/character-tools/src/cli.ts [--force]）
//
// 把 characters/linmengyao/source/ 下的资料（ADR 0010）转成 characters/linmengyao/st/ 下的角色卡和世界书，
// 每个档位一张卡 linmengyao-<档位>.json、一本场景世界书 linmengyao-scenes-<档位>.json（ADR 0003）。
// 平时在控制台的「林梦瑶」页面里改资料，保存时自动生成；直接改了 source/ 的文件，就跑这个。
// st/ 里的文件不要手改（会被覆盖）：目标文件已存在且内容不同时默认拒绝覆盖，确认要重新生成时加 --force。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacter } from './build.ts';
import { readSource } from './source.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const outDir = join(characterDir, 'st');

const force = process.argv.includes('--force');

const source = readSource(join(characterDir, 'source'));
const built = buildCharacter(source);

mkdirSync(outDir, { recursive: true });
let refused = false;
for (const [file, text] of built.files) {
    const path = join(outDir, file);
    const shown = relative(repoRoot, path);
    const old = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (old === text) {
        console.log(`没变 ${shown}`);
        continue;
    }
    if (old !== undefined && !force) {
        console.error(`跳过 ${shown}：已存在且内容不同，确认覆盖请加 --force`);
        refused = true;
        continue;
    }
    writeFileSync(path, text);
    console.log(`写入 ${shown}`);
}

console.log('档位：');
for (const tier of source.tiers.tiers) {
    const { lorebook } = built.tiers.find(t => t.tier === tier.name)!;
    const drop = tier.drop_scenes?.length ? `，去掉 ${tier.drop_scenes.join('、')}` : '';
    console.log(`  ${tier.name}：世界书 ${Object.keys(lorebook.entries).length} 条场景（取场景档 ${tier.scenes}${drop}）`);
}
if (refused) process.exitCode = 1;
