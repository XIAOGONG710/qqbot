// 手动让她做一次梦（用户 2026-10-31：「可以让她现在就做一个梦吗」）
// 跟夜里那个用同一套素材和提示词，只是不等睡觉时段。
//   node scripts/dream-now.mjs [--base <线路>] [--key <key>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendDream, dreamPrompt, readDreams } from '../packages/bot/src/life/dreams.ts';

const repo = process.cwd();
const soul = join(process.env.USERPROFILE ?? '', '.dsh', 'linmengyao');
const data = join(repo, 'runtime', 'bot-shadow');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const base = arg('--base', 'https://api.deepseek.com');
const key = arg('--key', process.env.QQBOT_LLM_API_KEY ?? '');
const model = arg('--model', 'deepseek-flash');
if (!key) { console.error('没有 QQBOT_LLM_API_KEY'); process.exit(2); }

const persona = existsSync(join(soul, 'PERSONA.md')) ? readFileSync(join(soul, 'PERSONA.md'), 'utf8').slice(0, 1500) : '';
let journal = '';
try { journal = readFileSync(join(soul, 'JOURNAL.md'), 'utf8').slice(-800); } catch { /* 没日记 */ }
let events = [];
try {
    const life = JSON.parse(readFileSync(join(soul, 'LIFE.json'), 'utf8'));
    events = (life.events ?? []).map(e => String(e.text ?? '')).filter(t => t && !t.includes('跟我说')).slice(-8);
} catch { /* 没 LIFE */ }
const previous = readDreams(data).slice(-3).map(item => item.dream);

const prompt = dreamPrompt({ events, feelings: [], journal, name: '林梦瑶', previous });
const response = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0.95, max_tokens: 1200, thinking: { type: 'disabled' }, messages: [{ role: 'system', content: persona + '\n\n' + prompt.system }, { role: 'user', content: prompt.user }] }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) { console.error(`失败 ${response.status}：${JSON.stringify(body).slice(0, 200)}`); process.exit(1); }
const text = body.choices?.[0]?.message?.content ?? '';
const match = text.match(/\{[\s\S]*\}/);
let parsed;
try { parsed = match ? JSON.parse(match[0]) : { dream: text.trim() }; } catch { parsed = { dream: text.trim() }; }
const dream = String(parsed.dream ?? '').trim();
if (!dream) { console.error('模型没写出梦'); process.exit(1); }
const at = Date.now();
const date = new Date(at).toISOString().slice(0, 10);
appendDream(data, {
    date, dream: dream.slice(0, 600), at, fragment: false,
    ...(parsed.feel?.kind ? { feel: { kind: parsed.feel.kind, strength: parsed.feel.strength === 3 ? 3 : 2, ...(parsed.feel.why ? { why: String(parsed.feel.why).slice(0, 80) } : {}) } } : {}),
});
console.log(`做了个梦（${[...dream].length} 字，记为 ${date}）：\n\n${dream}`);
if (parsed.feel) console.log(`\n醒来的情绪：${parsed.feel.kind} / ${parsed.feel.strength ?? 2}${parsed.feel.why ? `（${parsed.feel.why}）` : ''}`);
