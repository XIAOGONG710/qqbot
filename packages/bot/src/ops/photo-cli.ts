// node src/ops/photo-cli.ts list|add|remove [--dir <数据目录>]（她手机里的照片，ADR 0109）
//   list                                                  列出货架里的照片（编号、种类、说明、发过几次）
//   add <图片文件> --kind <cat|view|work|food> --caption "<照片里是什么>" [--dish "<菜名>"]   food 要写菜名（ADR 0128）
//   remove <编号>
// 照片放在 <数据目录>/photos/（默认 runtime/bot）：files/ 里是复制进去的原图，index.json 是清单。配置 photos 开了才会发；没有照片什么都不做。
// 写入使用 index.coordination.sqlite 协调活 bot/CLI（ADR 0233）；繁忙稍后重试，运行中不要删除协调文件。升级时先停止旧写者。
// 种类：cat 土豆（楼下的流浪猫）、view 窗外 / 路上的风景、work 她自己拍的片子、food 指定菜名的饭；不收本人自拍（ADR 0109/0128）。
// 说明写事实（“土豆趴在宿舍楼下的自行车棚顶上晒太阳”），不要写她的台词或情绪；照片都按“以前拍的”说，说明里别带“今天 / 刚刚”。
// 只收 jpg / png / webp，不超过 PHOTO_MAX_BYTES（当前 12 MiB）；同一张图重复加返回已有条目，缺失的缓存会恢复。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHOTO_KINDS, PHOTO_KIND_NAMES, photoShelf, type PhotoKind } from '../vision/photos.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), one('--dir') ?? resolve(repoRoot, 'runtime/bot'));
const shelf = photoShelf({ dir: resolve(dir, 'photos'), log: message => console.log(message) });
const command = args[0];

if (command === 'list') {
    const all = shelf.list();
    if (!all.length) console.log('货架是空的（没有照片她就什么都不发）');
    for (const entry of all) console.log(`${entry.id}  ${entry.kind.padEnd(4)}  发过 ${entry.used} 次  ${entry.caption}`);
    const have = shelf.status();
    console.log(`共 ${have.count} 张：${PHOTO_KINDS.map(kind => `${PHOTO_KIND_NAMES[kind]} ${have.byKind[kind]}`).join('，')}`);
} else if (command === 'add') {
    const file = args[1] && !args[1].startsWith('--') ? resolve(process.env.INIT_CWD ?? process.cwd(), args[1]) : undefined;
    const kind = one('--kind');
    const caption = one('--caption');
    const dish = one('--dish');
    if (!file || !kind || !PHOTO_KINDS.includes(kind as PhotoKind) || !caption) {
        console.error(`用法：add <图片文件> --kind <${PHOTO_KINDS.join('|')}> --caption "<照片里是什么>" [--dish "<菜名>"]`);
        process.exit(2);
    }
    if (kind === 'food' && !dish) { console.error('food 要用 --dish 写这是哪道菜（她只会发这一顿这道菜的）'); process.exit(2); }
    try {
        const entry = shelf.add(file, kind as PhotoKind, caption, dish);
        console.log(`好了：${entry.id}（${entry.kind}）${entry.caption}`);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
    }
} else if (command === 'remove') {
    const id = args[1];
    if (!id || !shelf.remove(id)) { console.error(`没有编号 ${id} 的照片`); process.exit(2); }
    console.log(`删掉了 ${id}（原图还留在 photos/files/，要彻底删手动删）`);
} else {
    console.error('用法：list | add <图片文件> --kind <cat|view|work|food> --caption "<…>" [--dish "<菜名>"] | remove <编号>   [--dir <数据目录>]');
    process.exit(2);
}
