// 用法：npm run convert -w @qqbot/character-tools
//      （或 node packages/character-tools/src/cli.ts）
//
// 把 characters/linmengyao/source/ 下的资料（ADR 0010）转成 characters/linmengyao/st/ 下的角色卡和世界书，
// 每个档位一张卡 linmengyao-<档位>.json、一本场景世界书 linmengyao-scenes-<档位>.json（ADR 0003）。
// 平时在控制台的「林梦瑶」页面里改资料，保存时自动生成；直接改了 source/ 的文件，就跑这个。
// st/ 只是生成结果，不要手改：每次都按资料覆盖（以前防 SillyTavern 手改的 --force 不再需要，写了也不报错）。
// 档位隐私检查不过就什么都不写。

import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCharacter, checkPrivacy, writeOutputs } from './build.ts';
import { readSource } from './source.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const outDir = join(characterDir, 'st');

const source = readSource(join(characterDir, 'source'));
const built = buildCharacter(source);
const problems = checkPrivacy(built, source);
if (problems.length) {
    console.error('档位隐私检查没过，没有写入 st/：');
    for (const p of problems) console.error(`  ${p.tier} ${p.where}：「${p.word}」…${p.excerpt}…`);
    process.exit(1);
}

const { written, unchanged } = writeOutputs(outDir, built);
for (const file of written) console.log(`写入 ${relative(repoRoot, join(outDir, file))}`);
console.log(`没变 ${unchanged.length} 个文件`);
console.log('档位：');
for (const tier of source.tiers.tiers) {
    const { lorebook } = built.tiers.find(t => t.tier === tier.name)!;
    const drop = tier.drop_scenes?.length ? `，去掉 ${tier.drop_scenes.join('、')}` : '';
    console.log(`  ${tier.name}：世界书 ${Object.keys(lorebook.entries).length} 条（场景档 ${tier.scenes}${drop}，另含按词触发的设定与已读书库）`);
}
