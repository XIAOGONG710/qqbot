// 用法：npm run convert -w @qqbot/character-tools
//      （或 node packages/character-tools/src/cli.ts）
//
// 把 characters/linmengyao/source/ 下的资料（ADR 0010）转成 characters/linmengyao/st/ 下的角色卡和世界书，
// 每个档位一张卡 linmengyao-<档位>.json、一本场景世界书 linmengyao-scenes-<档位>.json（ADR 0003）。
// 平时在控制台的「林梦瑶」页面里改资料，保存时自动生成；直接改了 source/ 的文件，就跑这个。
// st/ 只是生成结果，不要手改：每次都按资料覆盖（以前防 SillyTavern 手改的 --force 不再需要，写了也不报错）。
// 档位隐私检查不过就什么都不写。
//
// 可选参数（测试的合成角色用，见 packages/bot/test/fixtures/synthetic-character/README.md）：
//   --source <目录>  资料目录（默认 characters/linmengyao/source）
//   --out <目录>     输出目录（默认 characters/linmengyao/st）
//   --prefix <名字>  文件名前缀（默认 linmengyao）
// 相对路径按仓库根解析。不传参数时行为和以前完全一样。

import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildCharacter, checkPrivacy, writeOutputs } from './build.ts';
import { readSource } from './source.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const characterDir = join(repoRoot, 'characters/linmengyao');
const { values: args } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, prefix: { type: 'string' } } });
if (args.prefix !== undefined && !/^[a-z][a-z0-9-]*$/.test(args.prefix)) throw new Error('--prefix 只能用小写字母、数字和连字符');
const sourceDir = args.source === undefined ? join(characterDir, 'source') : resolve(repoRoot, args.source);
const outDir = args.out === undefined ? join(characterDir, 'st') : resolve(repoRoot, args.out);

const source = readSource(sourceDir);
const built = args.prefix === undefined ? buildCharacter(source) : buildCharacter(source, args.prefix);
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
// 承认版（ADR 0067）：对方不知道她是程序时用，linmengyao-<档位>-open.json，和原卡只差「被问是不是 AI」一段与两个否认场景
console.log(`  （另有 ${built.tiers.filter(t => t.base).length} 张承认版 -open：配置里 knowsBot 不是 true 的联系人用）`);
for (const tier of source.tiers.tiers) {
    const { lorebook } = built.tiers.find(t => t.tier === tier.name)!;
    const drop = tier.drop_scenes?.length ? `，去掉 ${tier.drop_scenes.join('、')}` : '';
    console.log(`  ${tier.name}：世界书 ${Object.keys(lorebook.entries).length} 条（场景档 ${tier.scenes}${drop}，另含按词触发的设定与已读书库）`);
}
