// 从**已批准**的真人语料里抽「他一句 → 真人女生怎么回」的例子，给例子检索用（ADR 0190 第 1 步）。
//   用法：node scripts/build-exemplars.mjs [输出 jsonl]
// 语料来源只有一个：exchange/research/2026-10-real-chat/v2（真人截图转写，Claude 复核过、不含用户与她的私聊）。
// 产出不进仓库（runtime/ 已忽略），换机器重跑本脚本即可。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

// exchange 仓库是另一个工作区，路径因机器而异：用环境变量 REAL_CHAT_DIR 指过去（指到 exchange/research/2026-10-real-chat/v2）
const ROOT = process.env.REAL_CHAT_DIR;
if (!ROOT) { console.error('请先设置环境变量 REAL_CHAT_DIR（exchange/research/2026-10-real-chat/v2 的路径）'); process.exit(2); }
const OUT = process.argv[2] ?? 'runtime/bot-shadow/exemplars/corpus.jsonl';
const files = ['samples.jsonl', 'closing-turns.jsonl', 'samples-b1.jsonl', 'samples-b2.jsonl', 'samples-b3.jsonl'];

/** 去标识：手机号、链接、@、长串数字 */
const clean = (text) => String(text)
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/\b1[3-9]\d{9}\b/g, '[号码]')
    .replace(/@\S+/g, '[艾特]')
    .replace(/\d{8,}/g, '[数字]')
    .replace(/\s+/g, ' ')
    .trim();

const rows = [];
const seen = new Set();
for (const name of files) {
    const path = `${ROOT}/${name}`;
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        const turns = Array.isArray(record.turns) ? record.turns : [];
        const her = record.her === 'A' ? 'A' : record.her === 'B' ? 'B' : 'B';
        for (let i = 0; i + 1 < turns.length; i++) {
            const him = turns[i];
            const hers = turns[i + 1];
            if (him.who === her || hers.who !== her) continue;
            const prompt = (him.bubbles ?? []).map(clean).filter(Boolean).join(' / ');
            const reply = (hers.bubbles ?? []).map(clean).filter(Boolean);
            if (!prompt || !reply.length) continue;
            const id = createHash('sha256').update(`${record.id}:${i}`).digest('hex').slice(0, 12);
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({
                id,
                source: `2026-10-real-chat/v2/${name}#${record.id}`,
                license: '用户提供并授权的真人聊天转写（非公开发布，只作内部语料）',
                relation: record.relation ?? 'unknown',
                scene: record.scene ?? 0,
                said: prompt.slice(0, 200),
                replied: reply.slice(0, 3).map(t => t.slice(0, 60)),
            });
        }
    }
}

mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(OUT, rows.map(row => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10));
const manifest = OUT.replace(/corpus\.jsonl$/, 'manifest.json');
writeFileSync(manifest, JSON.stringify({
    builtAt: new Date().toISOString(),
    sources: files.map(f => `2026-10-real-chat/v2/${f}`),
    note: '只收用户批准的这一份真人语料；不含用户与她的私聊，不抓平台评论。',
    count: rows.length,
}, null, 1));
console.log(`抽了 ${rows.length} 条例子 → ${OUT}`);
