// Read-only statistics over runtime/bot/chats/<qq>.jsonl. Prints numbers only: no message text, no names, no content words.
// Usage: node chat-audit.mjs <qq> [sinceISO]
import { readFileSync } from 'node:fs';

const qq = process.argv[2] ?? '2260168937';
const since = process.argv[3] ? Date.parse(process.argv[3]) : 0;
const rows = readFileSync(`C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/${qq}.jsonl`, 'utf8')
    .split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(row => row && typeof row.content === 'string' && (row.role === 'user' || row.role === 'assistant'))
    .map(row => ({ t: Date.parse(row.time), role: row.role, text: row.content }))
    .filter(row => row.t >= since)
    .sort((a, b) => a.t - b.t);

const isSticker = text => /^\[(?:图片表情|表情包|sticker|图片)/.test(text) || /^<sticker/.test(text);
const textual = rows.filter(row => !isSticker(row.text));
const q = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(0)}%` : 'n/a');
const fmt = x => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : 'n/a');
const len = text => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;

console.log(`rows: ${rows.length} (user ${rows.filter(r => r.role === 'user').length}, assistant ${rows.filter(r => r.role === 'assistant').length}); span ${new Date(rows[0].t).toISOString().slice(0, 10)} .. ${new Date(rows.at(-1).t).toISOString().slice(0, 10)}`);

// ── turns: a user burst (messages <= 90 s apart) followed by her bubbles (<= 25 s apart)
const turns = [];
for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== 'user') continue;
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].role === 'user' && rows[j + 1].t - rows[j].t <= 90_000) j++;
    const burst = rows.slice(i, j + 1);
    const bubbles = [];
    let k = j + 1;
    while (k < rows.length && rows[k].role === 'assistant' && (bubbles.length === 0 || rows[k].t - rows[k - 1].t <= 25_000)) { bubbles.push(rows[k]); k++; }
    if (bubbles.length) turns.push({ burst, bubbles, delay: bubbles[0].t - burst.at(-1).t });
    i = j;
}
console.log(`\n[turns] user-burst -> her reply: ${turns.length}`);
const nb = turns.map(t => t.bubbles.length);
console.log(`bubbles per turn: 1=${pct(nb.filter(n => n === 1).length, nb.length)}  2=${pct(nb.filter(n => n === 2).length, nb.length)}  3=${pct(nb.filter(n => n === 3).length, nb.length)}  4+=${pct(nb.filter(n => n >= 4).length, nb.length)}  (real chat reference in this project: one-bubble 51-65%)`);
const bubbleLens = turns.flatMap(t => t.bubbles.filter(b => !isSticker(b.text)).map(b => len(b.text)));
console.log(`chars per bubble: median ${fmt(q(bubbleLens, 0.5))}  p25 ${fmt(q(bubbleLens, 0.25))}  p75 ${fmt(q(bubbleLens, 0.75))}  p90 ${fmt(q(bubbleLens, 0.9))}  max ${Math.max(...bubbleLens)}`);
const herTotal = turns.map(t => t.bubbles.reduce((s, b) => s + (isSticker(b.text) ? 0 : len(b.text)), 0));
const hisTotal = turns.map(t => t.burst.reduce((s, b) => s + (isSticker(b.text) ? 0 : len(b.text)), 0));
console.log(`chars per turn: hers median ${fmt(q(herTotal, 0.5))} p90 ${fmt(q(herTotal, 0.9))}; his burst median ${fmt(q(hisTotal, 0.5))} p90 ${fmt(q(hisTotal, 0.9))}`);
const ratio = turns.map((t, i) => (hisTotal[i] > 0 ? herTotal[i] / hisTotal[i] : undefined)).filter(x => x !== undefined);
console.log(`her/his length ratio per turn: median ${fmt(q(ratio, 0.5))}  p90 ${fmt(q(ratio, 0.9))}  (a human partner mostly mirrors length; > 2 often = she over-answers)`);
const rank = a => { const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); idx.forEach(([, i], pos) => { r[i] = pos; }); return r; };
const pearson = (a, b) => { const n = a.length; const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return num / Math.sqrt(da * db); };
console.log(`length mirroring (Spearman, her turn chars vs his burst chars): ${fmt(pearson(rank(herTotal), rank(hisTotal)) * 100) }/100 (closer to 100 = mirrors him; ~0 = ignores how much he wrote)`);

// ── reply delay
const delays = turns.map(t => t.delay / 1000).filter(d => d >= 0 && d <= 3600);
console.log(`\n[delay] seconds from his last message to her first bubble: median ${fmt(q(delays, 0.5))}  p25 ${fmt(q(delays, 0.25))}  p75 ${fmt(q(delays, 0.75))}  p90 ${fmt(q(delays, 0.9))};  <=5s ${pct(delays.filter(d => d <= 5).length, delays.length)}  <=15s ${pct(delays.filter(d => d <= 15).length, delays.length)}  >=60s ${pct(delays.filter(d => d >= 60).length, delays.length)}  >=600s ${pct(delays.filter(d => d >= 600).length, delays.length)}`);

// ── her bubbles
const hers = rows.filter(r => r.role === 'assistant' && !isSticker(r.text));
const ends = text => { const t = text.trim(); return t[t.length - 1] ?? ''; };
const withEnd = (re) => hers.filter(b => re.test(ends(b.text))).length;
console.log(`\n[her bubbles] n=${hers.length}`);
console.log(`ends with: 。${pct(withEnd(/。/), hers.length)}  ！/!${pct(withEnd(/[！!]/), hers.length)}  ？/?${pct(withEnd(/[？?]/), hers.length)}  ～/~${pct(withEnd(/[～~]/), hers.length)}  …${pct(withEnd(/[…]/), hers.length)}  ，/、${pct(withEnd(/[，、,]/), hers.length)}  [face]${pct(hers.filter(b => /\]$/.test(b.text.trim())).length, hers.length)}  other/no punctuation ${pct(hers.filter(b => !/[。！!？?～~…，、,\]]$/.test(b.text.trim())).length, hers.length)}`);
const particles = ['啊', '呀', '啦', '嘛', '吧', '呢', '哦', '噢', '哈', '嘿', '呜', '哎', '嗯', '诶', '的', '了', '吗', '么'];
const lastCounts = particles.map(p => [p, hers.filter(b => ends(b.text.replace(/[。！!？?～~…]+$/g, '')) === p).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`final particle (before punctuation): ${lastCounts.map(([p, n]) => `${p}${pct(n, hers.length)}`).join('  ')}`);
console.log(`contains question mark: ${pct(hers.filter(b => /[？?]/.test(b.text)).length, hers.length)} of bubbles; turns whose LAST bubble asks something: ${pct(turns.filter(t => /[？?]/.test(t.bubbles.at(-1).text)).length, turns.length)}`);
console.log(`bubbles with 哈哈/嘿嘿/hh: ${pct(hers.filter(b => /哈哈|嘿嘿|hh/i.test(b.text)).length, hers.length)};  with a [face]: ${pct(hers.filter(b => /\[[^\]]{1,6}\]/.test(b.text)).length, hers.length)};  with ~: ${pct(hers.filter(b => /[～~]/.test(b.text)).length, hers.length)};  starts with 我: ${pct(hers.filter(b => b.text.trim().startsWith('我')).length, hers.length)}`);
console.log(`very short bubbles (<=3 chars): ${pct(hers.filter(b => len(b.text) <= 3).length, hers.length)};  long bubbles (>=25 chars): ${pct(hers.filter(b => len(b.text) >= 25).length, hers.length)};  bubbles with a comma-joined clause chain (>=3 commas): ${pct(hers.filter(b => (b.text.match(/[，,]/g) ?? []).length >= 3).length, hers.length)}`);

// ── repetition (numbers only)
const open2 = hers.map(b => b.text.trim().slice(0, 2));
const counts = new Map();
for (const o of open2) counts.set(o, (counts.get(o) ?? 0) + 1);
const topShare = [...counts.values()].sort((a, b) => b - a).slice(0, 5).reduce((s, n) => s + n, 0);
console.log(`\n[repetition] distinct 2-char openers: ${counts.size} of ${hers.length} bubbles; the 5 most common openers cover ${pct(topShare, hers.length)}`);
let repeatedOpener = 0;
for (let i = 1; i < hers.length; i++) if (open2.slice(Math.max(0, i - 8), i).includes(open2[i])) repeatedOpener++;
console.log(`bubble opens with the same 2 chars as one of her previous 8 bubbles: ${pct(repeatedOpener, hers.length - 1)}`);
const grams = new Map();
for (const b of hers) { const s = b.text.replace(/[\s\[\]，。！？、～~…,.!?]/g, ''); const seen = new Set(); for (let i = 0; i + 4 <= s.length; i++) seen.add(s.slice(i, i + 4)); for (const g of seen) grams.set(g, (grams.get(g) ?? 0) + 1); }
const heavy = [...grams.values()].filter(n => n >= 8);
console.log(`distinct 4-char sequences used in >=8 different bubbles: ${heavy.length}; the busiest one appears in ${pct(Math.max(0, ...heavy), hers.length)} of her bubbles`);
const pairs = new Map();
for (let i = 1; i < hers.length; i++) { const a = hers[i - 1].text.trim(), b = hers[i].text.trim(); if (a.length > 3 && a === b) pairs.set(a, 1); }
console.log(`bubbles identical to the one right before: ${pairs.size}`);

// ── her initiative: her messages with no user message in the previous 30 min
let proactive = 0; const byHour = new Array(24).fill(0);
for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== 'assistant') continue;
    const prev = rows[i - 1];
    if (prev && prev.role === 'assistant' && rows[i].t - prev.t <= 25_000) continue; // same turn
    if (!prev || rows[i].t - (rows.slice(0, i).reverse().find(r => r.role === 'user')?.t ?? 0) > 30 * 60_000) { proactive++; byHour[new Date(rows[i].t + 8 * 3600_000).getUTCHours()]++; }
}
const days = Math.max(1, Math.round((rows.at(-1).t - rows[0].t) / 86_400_000));
console.log(`\n[initiative] messages she started (no message from him in the previous 30 min): ${proactive} over ${days} days; by local hour: ${byHour.map((n, h) => (n ? `${String(h).padStart(2, '0')}h:${n}` : '')).filter(Boolean).join(' ')}`);
const gapsHim = []; for (let i = 1; i < rows.length; i++) if (rows[i].role === 'user' && rows[i - 1].role === 'assistant') gapsHim.push((rows[i].t - rows[i - 1].t) / 1000);
console.log(`his messages: median ${fmt(q(rows.filter(r => r.role === 'user' && !isSticker(r.text)).map(r => len(r.text)), 0.5))} chars; stickers/images sent by him ${pct(rows.filter(r => r.role === 'user' && isSticker(r.text)).length, rows.filter(r => r.role === 'user').length)} of his messages`);

// ── same definitions as exchange/research/2026-10-real-chat/findings.md (so the numbers can be compared)
const PARTICLE_RE = /[啊呀呢吧啦嘛哈诶嗷嗯唔嘞哟嘿哎咦唉哦噢喔]/;
const QUESTION_RE = /[？?]|吗$|呢$|什么|怎么|为什么|为啥|哪|几点|多少|多久|是不是|有没有|要不要|好不好|能不能|行不行|对不对|是吧$|对吧$/;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const redup = text => { const t = text.trim().replace(/[！!。～~…,，.]+$/g, ''); return t.length >= 2 && t.length <= 8 && /^(.{1,3})\1+$/u.test(t); };
console.log(`\n[comparable to the real-chat baseline: couples screenshots 482 bubbles / friends IM 7,171 bubbles]`);
console.log(`bubbles containing a modal particle (啊呀呢吧啦嘛哈诶嗷嗯唔嘞哟嘿哎咦唉哦噢喔): ${pct(hers.filter(b => PARTICLE_RE.test(b.text)).length, hers.length)}   (real couples: 18.5%)`);
console.log(`question-like bubbles (with or without a question mark, approximate): ${pct(hers.filter(b => QUESTION_RE.test(b.text.trim())).length, hers.length)}   (real: 10-16%)`);
console.log(`bubbles with a unicode emoji: ${pct(hers.filter(b => EMOJI_RE.test(b.text)).length, hers.length)}   (real couples: 3.2%)`);
console.log(`bubbles that are only ? or ？？ : ${pct(hers.filter(b => /^[？?]{1,7}$/.test(b.text.trim())).length, hers.length)}   (real: 7 occurrences in 30 couple segments, about 1.5% of bubbles)`);
console.log(`reduplication / echo bubbles (嗯嗯, 抱抱, 好好 type): ${pct(hers.filter(b => redup(b.text)).length, hers.length)}   (real: common in comfort/closeness turns; hers were 3 of 351 at the 10-09 check)`);
console.log(`chars per bubble vs real: hers median ${fmt(q(bubbleLens, 0.5))} / p75 ${fmt(q(bubbleLens, 0.75))} / p90 ${fmt(q(bubbleLens, 0.9))}   vs real couples 7 / 11 / 15 and friends 6-7 / 11 / 16`);
const shortShare = bubbleLens.filter(n => n <= 4).length;
console.log(`bubbles of 1-4 chars: ${pct(shortShare, bubbleLens.length)}; 5-8 chars: ${pct(bubbleLens.filter(n => n >= 5 && n <= 8).length, bubbleLens.length)}; 9-14: ${pct(bubbleLens.filter(n => n >= 9 && n <= 14).length, bubbleLens.length)}; 15+: ${pct(bubbleLens.filter(n => n >= 15).length, bubbleLens.length)}`);
