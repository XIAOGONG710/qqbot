// What still reads as "AI" in the recent live chat? Numbers + the repeated phrases. Reads her bubbles only; prints counts and short stock phrases, not his words.
const fs = require('node:fs');
const rows = fs.readFileSync('C:/Users/XG/Desktop/Project/qqbot/runtime/bot/chats/2260168937.jsonl', 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && typeof r.content === 'string');
const since = Date.parse(process.argv[2] ?? '2026-10-19T00:00:00+08:00');
const mine = rows.filter(r => r.role === 'assistant' && Date.parse(r.time) >= since && !r.content.startsWith('她发了个表情包'));
const text = r => r.content.replace(/\[[^\]]{1,12}\]/g, '');
const bigrams = s => { const c = [...s.replace(/[\s\p{P}\p{S}]/gu, '')]; const set = new Set(); for (let i = 0; i + 1 < c.length; i++) set.add(c[i] + c[i + 1]); return set; };
const jacc = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const g of a) if (b.has(g)) n++; return n / (a.size + b.size - n); };
console.log('她的气泡数（自', process.argv[2] ?? '10-19', '起）', mine.length);

// A. 带“理由 / 反驳”从句：反正、不然、要是、还用、免得、因为、所以、哪有、总不能、谁让
const LOGIC = /反正|不然|要是|还用|免得|否则|因为|所以|总不能|谁让|哪有|怎么可能|不就是|难怪|才不|早把|早就/;
const logic = mine.filter(r => LOGIC.test(text(r)));
console.log(`A 带“反正 / 不然 / 要是…还用 / 哪有”这类理由或反驳从句的气泡：${logic.length}（${Math.round(100 * logic.length / mine.length)}%）`);
console.log('   例：', logic.slice(0, 8).map(r => text(r).slice(0, 26)).join(' | '));

// B. 重复：和她前 8 条气泡里任何一条的两字词重合度 >= 0.5，或同一个 4 字片段出现在 3 条以上
let repeats = 0; const repeated = [];
mine.forEach((r, i) => {
    const g = bigrams(text(r)); if (g.size < 3) return;
    for (let j = Math.max(0, i - 8); j < i; j++) if (jacc(g, bigrams(text(mine[j]))) >= 0.5) { repeats++; repeated.push([text(mine[j]).slice(0, 20), text(r).slice(0, 20)]); break; }
});
console.log(`B 和前 8 条气泡高度重复的：${repeats}（${Math.round(100 * repeats / mine.length)}%）`);
console.log('   例：', repeated.slice(0, 6).map(([a, b]) => `「${a}」→「${b}」`).join(' | '));
const four = new Map();
for (const r of mine) { const c = [...text(r).replace(/[\s\p{P}\p{S}]/gu, '')]; const seen = new Set(); for (let i = 0; i + 4 <= c.length; i++) seen.add(c.slice(i, i + 4).join('')); for (const g of seen) four.set(g, (four.get(g) ?? 0) + 1); }
console.log('   出现在 >=3 条气泡里的 4 字片段：', [...four].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([g, n]) => `${g}×${n}`).join(' '));

// C. “别…”劝慰 / 叮嘱 / 方案：别往心里去、别瞎想、早点睡、试试、别自己
const ADVICE = /别(?:往心里去|瞎想|乱想|自己|硬撑|熬|放下|拆|担心|着急|急)|早点睡|试试|可以先|建议|记得|注意|保修|备份|休息/;
const advice = mine.filter(r => ADVICE.test(text(r)));
console.log(`C 叮嘱 / 劝慰 / 给方案（别往心里去、早点睡、试试……）：${advice.length}（${Math.round(100 * advice.length / mine.length)}%）`);
console.log('   例：', advice.slice(0, 8).map(r => text(r).slice(0, 22)).join(' | '));

// D. 解释自己 / 圆场：“是困得…”、“我的意思是”、“我只是”、“不是…是…”
const EXPLAIN = /是困得|我的意思|我只是|我是说|不是.{1,8}是|我没(?:敷衍|变|说错)|我说的算数|不算跑|不是设定|不是程序/;
const explain = mine.filter(r => EXPLAIN.test(text(r)));
console.log(`D 解释自己 / 自证（“是困得话都说不利索了”“我没敷衍”“不是设定”）：${explain.length}（${Math.round(100 * explain.length / mine.length)}%）`);
console.log('   例：', explain.slice(0, 8).map(r => text(r).slice(0, 26)).join(' | '));

// E. 单条里的逗号数（一句里塞两个小句，书面感）
const comma = mine.filter(r => (text(r).match(/[，,]/g) ?? []).length >= 1);
console.log(`E 一条里带逗号（两个小句连着说）的气泡：${comma.length}（${Math.round(100 * comma.length / mine.length)}%）；真人女生样本里同口径见 tail 下面的对照`);

// F. 她被追问时（他连发“真实想法 / 说清楚 / 然后呢”）有没有新内容：同一话题连续回应里的新词比例略；这里只数“就是…踏实 / 不用装”这类原地打转的词
const stock = ['踏实', '不用装', '困', '明天', '突然', '急', '脑子'];
console.log('F 本批里高频的“打转”词：', stock.map(w => `${w}×${mine.filter(r => text(r).includes(w)).length}`).join(' '));
