// 在真实图片上试跑 GPT 的收藏流程（ADR 0063 的看图 + 判断 + 下载）：
// 来源是开源仓库 ChineseBQB 的公开目录（zhaoolee.com/ChineseBQB），不登录、不抓网页，只按目录里的地址取少量图。
// 用法：node sticker-collect-trial.mts <代码根> <输出目录> [每类几张=3] [种子=1]
//   代码根：带 packages/bot/src/stickers.ts 的工作树（分支 sticker-sim 之后）；需要环境变量 QQBOT_LLM_API_KEY
//   输出目录：放目录副本、收藏库（stickers/）和结果（trial.json）；全在这里，不进仓库
// 对照组：故意混几类不该收的（时政、疫情、名人），看判断器拦不拦
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, out, perArg, seedArg] = process.argv.slice(2);
if (!root || !out) throw new Error('用法：node sticker-collect-trial.mts <代码根> <输出目录> [每类几张] [种子]');
const per = Number(perArg ?? 3);
let seed = Number(seedArg ?? 1);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const BASE = 'https://zhaoolee.com/ChineseBQB/';
// 她可能会留的：动物、可爱女孩、日常 meme 小人；对照：时政 / 疫情 / 名人 / 贡献暂存
const fromEnv = (name: string, fallback: string[]) => (process.env[name] === undefined ? fallback : process.env[name]!.split(',').map(x => x.trim()).filter(Boolean));
// 环境变量 TRIAL_LIKELY / TRIAL_CONTROL（逗号分隔的类别名，空串表示没有）可以换掉下面两组
const LIKELY = fromEnv('TRIAL_LIKELY', ['可爱的女孩纸', '是喵星人啦', '开心鸭', '沙雕企鹅', '小幺鸡', '狗', '鸽子', '猪', '鹦鹉', '沙雕情侣头像', '白色小人', '滑稽大佬', '全是心心', '斗图之王', '乌龟']);
const CONTROL = fromEnv('TRIAL_CONTROL', ['特朗普', '反港独', '冠状病毒', '罗翔', '微信网友贡献表情包']);

mkdirSync(out, { recursive: true });
const indexFile = join(out, 'bqb-search.json');
if (!existsSync(indexFile)) {
    const r = await fetch(`${BASE}catalog/search.json`);
    if (!r.ok) throw new Error(`目录下载失败 ${r.status}`);
    writeFileSync(indexFile, Buffer.from(await r.arrayBuffer()));
}
type Item = { src: string; categoryTitle: string; animated: boolean; bytes: number; width: number; height: number };
const all = JSON.parse(readFileSync(indexFile, 'utf8')) as Item[];

const pick: { group: 'likely' | 'control'; item: Item }[] = [];
for (const [group, names] of [['likely', LIKELY], ['control', CONTROL]] as const) {
    for (const name of names) {
        const pool = all.filter(i => i.categoryTitle.startsWith(name) && i.bytes <= 2_000_000);
        for (let k = 0; k < per && pool.length; k++) pick.push({ group, item: pool.splice(Math.floor(rand() * pool.length), 1)[0]! });
    }
}

const src = (p: string) => `file:///${join(root, 'packages/bot/src', p).replaceAll('\\', '/')}`;
const { stickerShelf, stickerDecider } = await import(src('stickers.ts'));
const { deepSeekImageDescriber, imageDownloader, STICKER_VISION_PROMPT } = await import(src('vision.ts'));
const { loadConfig, DEFAULTS } = await import(src('config.ts'));
const config = loadConfig(root);
const v = DEFAULTS.vision;
const describer = deepSeekImageDescriber({ baseUrl: v.baseUrl, model: v.model, apiKey: config.llm.apiKey, timeoutMs: v.timeoutMs,
    // 表情包专用的看图要求（先抄字再说画面）；TRIAL_PROMPT=default 用聊天里的旧要求做对照
    ...(process.env.TRIAL_PROMPT === 'default' || !STICKER_VISION_PROMPT ? {} : { prompt: STICKER_VISION_PROMPT }) },
    undefined, imageDownloader(Math.min(4000, v.timeoutMs)));

const log: string[] = [];
const trace = (m: string) => { log.push(m); console.log(m); };
const results: Record<string, unknown>[] = [];
const rows = new Map<string, (typeof pick)[number]>();
const byUrl = (u: string) => rows.get(u)!;
const t0 = new Map<string, number>();

const shelf = stickerShelf({
    dir: join(out, 'stickers'),
    describe: async img => {
        t0.set(img.url, Date.now());
        const d = await describer.describe(img);
        const row = byUrl(img.url);
        results.push({ stage: 'described', group: row.group, category: row.item.categoryTitle, animated: row.item.animated, src: row.item.src, description: d, ms: Date.now() - t0.get(img.url)! });
        return d;
    },
    decide: async (description: string, summary?: string) => {
        const d = await stickerDecider(config.llm, trace)(description, summary);
        results.push({ stage: 'decided', description, keep: d.keep, final: d.description, tags: d.tags });
        return d;
    },
    log: trace,
    discoveryPerRun: pick.length,
    discover: async () => pick.map(p => { const u = BASE + p.item.src; rows.set(u, p); return u; }),
});
await shelf.discover();
// discover() 里是逐个 await 的，返回时已经全部处理完
await new Promise(r => setTimeout(r, 500));

const decided = results.filter(r => r.stage === 'decided');
const described = results.filter(r => r.stage === 'described');
const kept = decided.filter(r => r.keep).length;
console.log(`\n候选 ${pick.length}；看图成功 ${described.length}；判断 ${decided.length}；收下 ${kept}；库内 ${shelf.status().count}`);
writeFileSync(join(out, 'trial.json'), JSON.stringify({ pick: pick.map(p => ({ group: p.group, category: p.item.categoryTitle, src: p.item.src, animated: p.item.animated })), results, log }, null, 2));
