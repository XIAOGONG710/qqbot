// 给表情包收藏库放一批「已经审过的初始存货」：用 sticker-collect-trial.mts 在真图上跑出来的、用户看过试跑页的那几批，
// 按类别均匀挑 N 张，连图带描述放进目标收藏库，并把它们的来源地址记进 seen（上线后每天的公开目录候选不会再重复看它们）。
// 用法：node sticker-seed.mjs <目标收藏库目录> <N> <试跑目录> [<试跑目录> ...] --root <代码根> [--dry]
//   代码根：带 packages/bot/src/sticker-sources.ts 的工作树；只放「按现在的类别名单和硬黑名单仍然合格」的图——
//   试跑里为了检查判断器故意混进去的对照类（特朗普等）、后来没收的类别，都不会被放进去
//   试跑目录里要有 stickers/index.json 和 trial.json（trial.json 里 described/decided 一一对应）
// 注意：目标收藏库正被 Koishi 用着时不要跑（进程会把内存里的 index 写回去覆盖）；上线时先停 Koishi 再放。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? args[rootAt + 1] : undefined;
const positional = args.filter((a, i) => a !== '--dry' && a !== '--root' && i !== rootAt + 1);
const [target, nArg, ...libs] = positional;
if (!target || !nArg || !libs.length || !root) throw new Error('用法：node sticker-seed.mjs <目标收藏库目录> <N> <试跑目录> ... --root <代码根> [--dry]');
const { acceptBqbItem, BQB_DEFAULT_ALLOW } = await import(pathToFileURL(join(root, 'packages/bot/src/sticker-sources.ts')).href);
const N = Number(nArg);
const BASE = 'https://zhaoolee.com/ChineseBQB/';
const sourceKey = url => createHash('sha256').update(url).digest('hex').slice(0, 24);

const candidates = [];
for (const lib of libs) {
    const index = JSON.parse(readFileSync(join(lib, 'stickers/index.json'), 'utf8'));
    const t = JSON.parse(readFileSync(join(lib, 'trial.json'), 'utf8'));
    const described = t.results.filter(r => r.stage === 'described');
    const decided = t.results.filter(r => r.stage === 'decided');
    const meta = new Map();
    described.forEach((d, i) => { if (decided[i]) meta.set(decided[i].final, { src: d.src, category: String(d.category).replace(/[^\p{L}\p{N}]/gu, '') }); });
    for (const e of index.entries) {
        const m = meta.get(e.description);
        if (!m?.src || !existsSync(join(lib, 'stickers', e.file))) continue;
        if (!acceptBqbItem({ src: m.src, categoryTitle: m.category, bytes: 1000, width: 100, height: 100 }, BQB_DEFAULT_ALLOW)) continue;
        candidates.push({ entry: e, dir: join(lib, 'stickers'), category: m.category, url: BASE + m.src });
    }
}
// 按类别轮流取，同一个编号只取一次
const groups = new Map();
for (const c of candidates) groups.set(c.category, [...(groups.get(c.category) ?? []), c]);
const seenIds = new Set();
const picked = [];
for (let round = 0; picked.length < N; round++) {
    let any = false;
    for (const list of groups.values()) {
        const c = list[round];
        if (!c) continue;
        any = true;
        if (seenIds.has(c.entry.id) || picked.length >= N) continue;
        seenIds.add(c.entry.id);
        picked.push(c);
    }
    if (!any) break;
}
console.log(`候选 ${candidates.length}，类别 ${groups.size}，挑出 ${picked.length}`);
if (dry) { for (const c of picked) console.log(' ', c.category.slice(0, 8), '|', c.entry.description); process.exit(0); }

mkdirSync(target, { recursive: true });
const indexPath = join(target, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { version: 1, entries: [], seen: [] };
const have = new Set(index.entries.map(e => e.id));
const now = Date.now();
let added = 0;
picked.forEach((c, i) => {
    if (have.has(c.entry.id)) return;
    copyFileSync(join(c.dir, c.entry.file), join(target, c.entry.file));
    index.entries.push({
        ...c.entry,
        source: { kind: 'bqb', name: 'ChineseBQB' },
        createdAt: new Date(now - (picked.length - i) * 60_000).toISOString(),
        used: 0,
    });
    index.seen = [...index.seen.filter(k => k !== sourceKey(c.url)), sourceKey(c.url)].slice(-500);
    added++;
});
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(`放进 ${added} 张 → ${target}（库内共 ${index.entries.length}）`);
