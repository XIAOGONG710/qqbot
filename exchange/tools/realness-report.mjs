// 只读：一条命令出“她离真人还差多少”的数字（只出数字，不出任何原话 / 名字）。每周跑一次，同一把尺子对比。
// 用法：node realness-report.mjs [起始日期，默认 7 天前] [联系人 qq，默认 2260168937]
// 读：runtime/bot/chats/<qq>.jsonl、proactive/<qq>-boyfriend.json、world/events.json、logs/*.log（只数行，不输出内容）
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'C:/Users/XG/Desktop/Project/qqbot/runtime/bot';
const sinceArg = process.argv[2];
const qq = process.argv[3] ?? '2260168937';
const since = sinceArg ? Date.parse(sinceArg) : Date.now() - 7 * 86_400_000;
const days = Math.max(1, (Date.now() - since) / 86_400_000);

const pct = (n, d) => (d ? `${(100 * n / d).toFixed(0)}%` : 'n/a');
const q = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = x => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : 'n/a');
const len = text => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;
const isMedia = text => /^\[(?:图片表情|表情包|动画表情|sticker|图片|语音|B 站私信)/.test(text) || /^<(?:sticker|photo)/.test(text) || /^她发了张照片/.test(text);
const isSticker = text => /^\[(?:图片表情|表情包|动画表情)/.test(text) || /^<sticker/.test(text);

const rows = readFileSync(join(root, 'chats', `${qq}.jsonl`), 'utf8').split(/\r?\n/).filter(Boolean)
    .flatMap(line => { try { const r = JSON.parse(line); return [{ t: Date.parse(r.time), role: r.role, text: String(r.content ?? '') }]; } catch { return []; } })
    .filter(r => r.t >= since).sort((a, b) => a.t - b.t);
const hers = rows.filter(r => r.role === 'assistant');
const his = rows.filter(r => r.role === 'user');

console.log(`# 离真人还差多少（${new Date(since).toLocaleDateString('zh-CN')} 起，${days.toFixed(1)} 天；他 ${his.length} 条、她 ${hers.length} 条）`);

// ── 形状：每轮几条、每条多长、延迟
const turns = [];
for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== 'user') continue;
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].role === 'user' && rows[j + 1].t - rows[j].t <= 90_000) j++;
    const bubbles = [];
    let k = j + 1;
    while (k < rows.length && rows[k].role === 'assistant' && (!bubbles.length || rows[k].t - rows[k - 1].t <= 25_000)) { bubbles.push(rows[k]); k++; }
    if (bubbles.length) turns.push({ burst: rows.slice(i, j + 1), bubbles, delay: (bubbles[0].t - rows[j].t) / 1000 });
    i = j;
}
const texts = turns.flatMap(t => t.bubbles.filter(b => !isMedia(b.text)).map(b => len(b.text)));
const delays = turns.map(t => t.delay);
console.log('\n## 说话的样子（真人参考：每条中位 6–7 字、p90 15–16，一轮一条 51–65%，WhatsApp 回复 57.8% 在 1 分钟内）');
console.log(`轮数 ${turns.length}；每条字数 中位 ${fmt(q(texts, 0.5))} p90 ${fmt(q(texts, 0.9))}；一轮一条 ${pct(turns.filter(t => t.bubbles.length === 1).length, turns.length)}`);
console.log(`第一条延迟（秒）中位 ${fmt(q(delays, 0.5))} p25 ${fmt(q(delays, 0.25))} p75 ${fmt(q(delays, 0.75))} p90 ${fmt(q(delays, 0.9))}；≤15 秒 ${pct(delays.filter(d => d <= 15).length, delays.length)}；> 60 秒 ${pct(delays.filter(d => d > 60).length, delays.length)}；> 5 分钟 ${pct(delays.filter(d => d > 300).length, delays.length)}`);

// ── 表情和语气（他自己是最近的真人参照）
const rate = (list, test) => pct(list.filter(r => test(r.text)).length, list.length);
const face = text => /\[[^\]\n]{1,6}\]/.test(text) && !isMedia(text);
console.log('\n## 表情和语气（他 → 她；越接近他越像一对）');
console.log(`图片表情 ${rate(his, isSticker)} → ${rate(hers, isSticker)}；小黄脸 ${rate(his, face)} → ${rate(hers, face)}；「～」 ${rate(his, t => /[～~]/.test(t))} → ${rate(hers, t => /[～~]/.test(t))}；哈哈类 ${rate(his, t => /哈哈|嘿嘿|hh|233|笑死/.test(t))} → ${rate(hers, t => /哈哈|嘿嘿|hh|233|笑死/.test(t))}`);
console.log(`问句 ${rate(hers.filter(r => !isMedia(r.text)), t => /[？?]$|[吗呢吧]$/.test(t))}（真人 10–16%）；语气词 ${rate(hers.filter(r => !isMedia(r.text)), t => /[啊呀呢吧啦嘛哈诶嗷嗯唔嘞哟嘿哎咦唉哦噢喔]/.test(t))}（真人 18.5%）；他的字数中位 ${fmt(q(his.filter(r => !isMedia(r.text)).map(r => len(r.text)), 0.5))}`);

// ── 主动性
const proactiveFile = join(root, 'proactive', `${qq}-boyfriend.json`);
console.log('\n## 主动性');
if (existsSync(proactiveFile)) {
    const state = JSON.parse(readFileSync(proactiveFile, 'utf8'));
    const records = (state.records ?? []).filter(r => Date.parse(r.at ?? r.plannedAt) >= since);
    const sent = records.filter(r => r.result === 'sent');
    const answered = sent.filter(r => { const t = Date.parse(r.at); const next = his.find(m => m.t > t); return next && next.t - t <= 30 * 60_000; });
    const byOccasion = {};
    for (const r of sent) byOccasion[r.occasion] = (byOccasion[r.occasion] ?? 0) + 1;
    console.log(`主动发出 ${sent.length} 条（${(sent.length / days).toFixed(1)}/天）；30 分钟内他回 ${pct(answered.length, sent.length)}；跳过 ${records.filter(r => r.result === 'skipped').length}、失败 ${records.filter(r => r.result === 'failed').length}；按时机 ${JSON.stringify(byOccasion)}`);
    const thoughts = (state.inner?.thoughts ?? []).filter(t => Date.parse(t.at) >= since);
    const tl = thoughts.map(t => [...t.text].length);
    console.log(`内心：念头 ${thoughts.length} 个（${(thoughts.length / days).toFixed(1)}/天），字数中位 ${fmt(q(tl, 0.5))}；想告诉他 ${thoughts.filter(t => t.goes === 'tell').length}、想问他 ${thoughts.filter(t => t.goes === 'ask').length}、自己想想 ${thoughts.filter(t => t.goes === 'keep').length}；含“你”的 ${thoughts.filter(t => t.text.includes('你')).length}`);
}

// ── 她的日子
const eventsFile = join(root, 'world', 'events.json');
console.log('\n## 她的日子');
if (existsSync(eventsFile)) {
    const parsed = JSON.parse(readFileSync(eventsFile, 'utf8'));
    const events = (Array.isArray(parsed) ? parsed : parsed.events ?? []).filter(e => Date.parse(e.endedAt) >= since);
    const byKind = {};
    for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    console.log(`账上行动 ${events.length} 件（${(events.length / days).toFixed(1)}/天）：${JSON.stringify(byKind)}；被打断 ${events.filter(e => e.result === 'interrupted').length}`);
}

// ── 日志：心境 / 会拒绝 / 小事 / 延迟 / 断网（只数行，不输出内容）
const logDir = join(root, 'logs');
const counts = {};
const bump = (key, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };
const failures = [];
if (existsSync(logDir)) {
    for (const file of readdirSync(logDir).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()) {
        if (Date.parse(file.slice(0, 10)) + 86_400_000 < since) continue;
        for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
            const m = /^\[(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\]/.exec(line);
            if (m) {
                const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
                if (t < since) continue;
                if (line.includes('回复失败') || line.includes('没连上模型')) failures.push(t);
            }
            if (line.includes('心境：')) bump(`心境·${/心境：([^·（]+)·(很重|明显)/.exec(line)?.slice(1, 3).join('·') ?? '?'}`);
            if (line.includes('这一轮有意图：你刚推了他')) bump('会拒绝·被磨时守着');
            if (line.includes('这一轮有意图：他在管着你')) bump('会拒绝·被管着');
            if (line.includes('这一轮有意图：你正在')) bump('会拒绝·先弄完这一小段');
            if (line.includes('在做别的，')) bump('延迟·分心');
            if (line.includes('回复失败')) bump('回复失败');
            if (line.includes('内心') && line.includes('写成了对他说话')) bump('内心·写成对他说话');
            if (line.includes('图片表情：这一轮抽到')) bump('图片表情·抽到');
        }
    }
}
console.log('\n## 日志里数到的（新功能有没有真的在发生）');
console.log(Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join('；') || '（没有）');
// 回复失败的行，相隔不到 30 分钟的算同一次断（这是下限：整机复位、守护程序自己的告警期间日志里什么都没有）
const clusters = [];
for (const t of failures.sort((a, b) => a - b)) {
    const last = clusters.at(-1);
    if (last && t - last.end <= 30 * 60_000) last.end = t;
    else clusters.push({ start: t, end: t });
}
const downHours = clusters.reduce((sum, c) => sum + (c.end - c.start) / 3_600_000, 0);
console.log(`\n## 在不在（下限）\n回复失败成 ${clusters.length} 次断，合计至少 ${downHours.toFixed(1)} 小时回不了话；最长一次 ${fmt(Math.max(0, ...clusters.map(c => (c.end - c.start) / 3_600_000)))} 小时。整机复位 / 日志里什么都没有的时间没算进去（见 exchange/BOARD.md 的可靠性一节）`);
