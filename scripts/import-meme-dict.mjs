// 把「梗百科」词库（cnmeme.wiki 那份 sqlite）化成我们自己的数据文件。
// 只做一次性转换：读完就丢，运行时不认识 sqlite、也不依赖别人的仓库。
//   用法：node scripts/import-meme-dict.mjs <memes.db> <输出 dict.json>
// 产出的字段是我们自己的口径：term / meaning（怎么用，压成一句）/ origin / tags / summary / source。
import { readFileSync, writeFileSync } from 'node:fs';

const [dbPath, outPath] = process.argv.slice(2);
if (!dbPath || !outPath) {
    console.error('用法：node scripts/import-meme-dict.mjs <memes.db> <dict.json>');
    process.exit(2);
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT title, tags, usage, origin, summary FROM memes').all();

const firstSentence = (text) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    const cut = clean.split(/(?<=[。！？!?])/)[0] ?? clean;
    return cut.length > 60 ? `${cut.slice(0, 60)}…` : cut;
};

const entries = rows
    .map((r) => ({
        term: String(r.title ?? '').trim(),
        meaning: firstSentence(r.usage),
        origin: String(r.origin ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        tags: String(r.tags ?? '').trim(),
        summary: firstSentence(r.summary),
    }))
    .filter(e => e.term.length >= 2 && e.meaning);

writeFileSync(outPath, JSON.stringify({
    version: 1,
    source: 'cnmeme.wiki（经 dsh-memewiki 的 sqlite 快照转写；只作离线字典，不随我们的学习管线更新）',
    importedAt: new Date().toISOString(),
    entries,
}, null, 0));
console.log(`转写 ${entries.length} 条 → ${outPath}（原库 ${rows.length} 条）`);
