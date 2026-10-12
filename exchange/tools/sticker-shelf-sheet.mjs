// 把表情包收藏库（index.json + 图片文件）做成一页本地网页，给人看「她收了什么」。只读，不改收藏库。
// 用法：node sticker-shelf-sheet.mjs <收藏库目录> [输出 html，默认放在收藏库目录里] [trial.json]
//   trial.json 是 sticker-collect-trial.mts 的输出，给了就在每张图下面标出它来自哪个类别、是不是对照组
// 图片用相对路径引用，所以 html 要和图片放在同一个目录里看（默认就是）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, outArg, trialPath] = process.argv.slice(2);
if (!dir) throw new Error('用法：node sticker-shelf-sheet.mjs <收藏库目录> [输出 html] [trial.json]');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const origin = new Map();
if (trialPath) {
    const t = JSON.parse(readFileSync(trialPath, 'utf8'));
    const described = t.results.filter(r => r.stage === 'described');
    const decided = t.results.filter(r => r.stage === 'decided');
    described.forEach((d, i) => origin.set(decided[i]?.final, { group: d.group, category: String(d.category).replace(/[^\p{L}\p{N}]/gu, '') }));
}

const cards = index.entries.map(e => {
    const o = origin.get(e.description);
    const tag = o ? `<div class="src ${o.group}">${o.group === 'control' ? '对照组 · ' : ''}${esc(o.category)}</div>` : '';
    return `<figure><img src="${esc(e.file)}" loading="lazy"><figcaption>${esc(e.description)}<div class="tags">${e.tags.map(esc).join(' · ')}</div>${tag}<div class="id">${esc(e.id)}</div></figcaption></figure>`;
}).join('\n');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>她收藏的表情包</title>
<style>
body{font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif;margin:16px;background:#fafafa;color:#222}
h1{font-size:18px} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px}
img{width:100%;height:150px;object-fit:contain;background:#f0f0f0;border-radius:4px}
figcaption{font-size:12px;margin-top:6px} .tags{color:#666} .id{color:#aaa;font-size:11px}
.src{display:inline-block;margin-top:4px;padding:1px 6px;border-radius:8px;background:#e8f0fe;color:#1a56b0}
.src.control{background:#fdecea;color:#b3261e}
</style></head><body>
<h1>她收藏的表情包（${index.entries.length} 个）</h1>
<p>每张图下面是看图模型写的描述、场景词和编号。红色标签是故意混进去的对照组（不该收的类别），用来检查判断器。</p>
<div class="grid">
${cards}
</div></body></html>
`;
const out = outArg ?? join(dir, 'index.html');
writeFileSync(out, html);
console.log(`${index.entries.length} 张 → ${out}`);
