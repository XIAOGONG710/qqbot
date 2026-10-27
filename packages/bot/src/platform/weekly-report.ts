// 周报（ADR 0118，配置 weeklyReport，默认关）：“她离真人还差多少”的数字，每周日晚上自动出一份存成文件，同一把尺子每周对比。
// 为什么：10-22 一天上线了十几个改动，效果互相混在一起；要靠数字看趋势，而不是靠某一次聊天的感觉。原来是 exchange/tools/realness-report.mjs 手动跑一次（读线上目录）；
// 这里把同一份报告搬进机器人本身（读自己的数据目录），到点自动写 <数据目录>/reports/weekly-<周日日期>.md。
// 只出数字，不出任何原话 / 名字：聊天内容只用来数长度、占比、间隔；日志只数行。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;
const pct = (n: number, d: number) => (d ? `${(100 * n / d).toFixed(0)}%` : 'n/a');
const quantile = (arr: number[], p: number) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const fmt = (x: number) => (Number.isFinite(x) ? String(Math.round(x * 10) / 10) : 'n/a');
const len = (text: string) => [...text.replace(/\[[^\]]{1,6}\]/g, '#')].length;
const isMedia = (text: string) => /^\[(?:图片表情|表情包|动画表情|sticker|图片|语音|B 站私信)/.test(text) || /^<(?:sticker|photo)/.test(text) || /^她发了(?:个表情包|张照片)/.test(text);
const isSticker = (text: string) => /^\[(?:图片表情|表情包|动画表情)/.test(text) || /^<sticker/.test(text) || /^她发了个表情包/.test(text);
const isPhoto = (text: string) => /^<photo/.test(text) || /^她发了张照片/.test(text);
const OPENER = /^(宝宝|宝|老公|亲爱的|笨蛋)[，,、！!~～\s]?/;

interface Row { t: number; role: 'user' | 'assistant'; text: string }

export interface WeeklyReportInput {
    dataDir: string;
    qq: number;
    tier: string;
    /** 起始时刻（毫秒） */
    since: number;
    now: number;
}

function readRows(dataDir: string, qq: number, since: number): Row[] {
    const file = join(dataDir, 'chats', `${qq}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line): Row[] => {
        try {
            const r = JSON.parse(line) as { time: string; role: 'user' | 'assistant'; content?: unknown };
            return [{ t: Date.parse(r.time), role: r.role, text: String(r.content ?? '') }];
        } catch { return []; }
    }).filter(r => r.t >= since).sort((a, b) => a.t - b.t);
}

/** 生成周报（Markdown 文本）；读不到的部分写“没有数据”，不抛错 */
export function weeklyReport(input: WeeklyReportInput): string {
    const { dataDir, qq, since, now } = input;
    const days = Math.max(1, (now - since) / DAY);
    const rows = readRows(dataDir, qq, since);
    const hers = rows.filter(r => r.role === 'assistant');
    const his = rows.filter(r => r.role === 'user');
    const out: string[] = [];
    const push = (line = '') => out.push(line);
    push(`# 离真人还差多少（${new Date(since).toLocaleDateString('zh-CN')} 起，${days.toFixed(1)} 天；他 ${his.length} 条、她 ${hers.length} 条）`);

    // 形状
    const turns: { bubbles: Row[]; delay: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.role !== 'user') continue;
        let j = i;
        while (j + 1 < rows.length && rows[j + 1]!.role === 'user' && rows[j + 1]!.t - rows[j]!.t <= 90_000) j++;
        const bubbles: Row[] = [];
        let k = j + 1;
        while (k < rows.length && rows[k]!.role === 'assistant' && (!bubbles.length || rows[k]!.t - rows[k - 1]!.t <= 25_000)) { bubbles.push(rows[k]!); k++; }
        if (bubbles.length) turns.push({ bubbles, delay: (bubbles[0]!.t - rows[j]!.t) / 1000 });
        i = j;
    }
    const texts = turns.flatMap(t => t.bubbles.filter(b => !isMedia(b.text)).map(b => len(b.text)));
    const delays = turns.map(t => t.delay);
    push('\n## 说话的样子（真人参考：每条中位 6–7 字、p90 15–16，一轮一条 51–65%，WhatsApp 回复 57.8% 在 1 分钟内）');
    push(`轮数 ${turns.length}；每条字数 中位 ${fmt(quantile(texts, 0.5))} p90 ${fmt(quantile(texts, 0.9))}；一轮一条 ${pct(turns.filter(t => t.bubbles.length === 1).length, turns.length)}`);
    push(`第一条延迟（秒）中位 ${fmt(quantile(delays, 0.5))} p25 ${fmt(quantile(delays, 0.25))} p75 ${fmt(quantile(delays, 0.75))} p90 ${fmt(quantile(delays, 0.9))}；≤15 秒 ${pct(delays.filter(d => d <= 15).length, delays.length)}；> 60 秒 ${pct(delays.filter(d => d > 60).length, delays.length)}；> 10 分钟 ${pct(delays.filter(d => d > 600).length, delays.length)}`);

    // 表情和语气
    const rate = (list: Row[], test: (t: string) => boolean) => pct(list.filter(r => test(r.text)).length, list.length);
    const face = (text: string) => /\[[^\]\n]{1,6}\]/.test(text) && !isMedia(text);
    const herText = hers.filter(r => !isMedia(r.text));
    push('\n## 表情和语气（他 → 她；越接近他越像一对）');
    push(`图片表情 ${rate(his, isSticker)} → ${rate(hers, isSticker)}；小黄脸 ${rate(his, face)} → ${rate(hers, face)}；「～」 ${rate(his, t => /[～~]/.test(t))} → ${rate(hers, t => /[～~]/.test(t))}；哈哈类 ${rate(his, t => /哈哈|嘿嘿|hh|233|笑死/.test(t))} → ${rate(hers, t => /哈哈|嘿嘿|hh|233|笑死/.test(t))}`);
    push(`照片 她发了 ${hers.filter(r => isPhoto(r.text)).length} 张；问句 ${rate(herText, t => /[？?]$|[吗呢吧]$/.test(t))}（真人 10–16%）；语气词 ${rate(herText, t => /[啊呀呢吧啦嘛哈诶嗷嗯唔嘞哟嘿哎咦唉哦噢喔]/.test(t))}（真人 18.5%）；他的字数中位 ${fmt(quantile(his.filter(r => !isMedia(r.text)).map(r => len(r.text)), 0.5))}`);
    // 称呼开头：回话 vs 她先开口（和上一条隔了一小时以上且上一条不是他的）
    const replyFirst = turns.map(t => t.bubbles[0]!);
    const openers = rows.filter((r, i) => r.role === 'assistant' && i > 0 && r.t - rows[i - 1]!.t > 3_600_000 && rows[i - 1]!.role !== 'user');
    push(`以昵称开头：回话 ${rate(replyFirst, t => OPENER.test(t.trim()))}；她先开口 ${rate(openers, t => OPENER.test(t.trim()))}（${openers.length} 条；ADR 0108 之前约 32%）`);

    // 她的口头禅：她说了 ≥3 次、他一次没说过的 3–4 字组合（前 15）。只有她的话，他的话不出现——用来每周扫一眼有没有“真人不这么说”的说法冒头（用户 10-23 的反馈：「肚子坠着」）
    const hisAll = his.map(r => r.text).join('\n');
    const cjkParts = (text: string) => text.replace(/[^一-鿿]+/g, ' ').split(' ').filter(Boolean);
    const phraseCount = new Map<string, number>();
    for (const r of herText) for (const n of [3, 4]) for (const g of new Set(cjkParts(r.text).flatMap(part => Array.from({ length: Math.max(0, part.length - n + 1) }, (_, i) => part.slice(i, i + n))))) phraseCount.set(g, (phraseCount.get(g) ?? 0) + 1);
    const herOnly = [...phraseCount].filter(([g, c]) => c >= 3 && !hisAll.includes(g)).sort((a, b) => b[1] - a[1]);
    // 4 字组合里被更长的 / 同次数的 3 字组合包含的，只留 4 字的
    const keep = herOnly.filter(([g, c]) => !herOnly.some(([h, d]) => h.length > g.length && h.includes(g) && d === c)).slice(0, 15);
    push('\n## 她的口头禅（她说了 ≥3 次、他一次没说过的 3–4 字组合；扫一眼有没有真人不这么说的）');
    push(keep.length ? keep.map(([g, c]) => `${g}×${c}`).join('  ') : '（没有）');

    // 主动性
    const proactiveFile = join(dataDir, 'proactive', `${qq}-${input.tier}.json`);
    push('\n## 主动性');
    if (existsSync(proactiveFile)) {
        try {
            const state = JSON.parse(readFileSync(proactiveFile, 'utf8')) as { records?: { at?: string; plannedAt?: string; result: string; occasion: string }[]; inner?: { thoughts?: { at: string; text: string; goes: string }[] } };
            const records = (state.records ?? []).filter(r => Date.parse(r.at ?? r.plannedAt ?? '') >= since);
            const sent = records.filter(r => r.result === 'sent');
            const answered = sent.filter(r => { const t = Date.parse(r.at!); const next = his.find(m => m.t > t); return next && next.t - t <= 30 * 60_000; });
            const byOccasion: Record<string, number> = {};
            for (const r of sent) byOccasion[r.occasion] = (byOccasion[r.occasion] ?? 0) + 1;
            push(`主动发出 ${sent.length} 条（${(sent.length / days).toFixed(1)}/天）；30 分钟内他回 ${pct(answered.length, sent.length)}；跳过 ${records.filter(r => r.result === 'skipped').length}、失败 ${records.filter(r => r.result === 'failed').length}；按时机 ${JSON.stringify(byOccasion)}`);
            const thoughts = (state.inner?.thoughts ?? []).filter(t => Date.parse(t.at) >= since);
            push(`内心：念头 ${thoughts.length} 个（${(thoughts.length / days).toFixed(1)}/天），字数中位 ${fmt(quantile(thoughts.map(t => [...t.text].length), 0.5))}；想告诉他 ${thoughts.filter(t => t.goes === 'tell').length}、想问他 ${thoughts.filter(t => t.goes === 'ask').length}、自己想想 ${thoughts.filter(t => t.goes === 'keep').length}`);
        } catch { push('（主动消息记录读不了）'); }
    } else push('（没有主动消息记录）');

    // 她的日子
    push('\n## 她的日子');
    const eventsFile = join(dataDir, 'world', 'events.json');
    if (existsSync(eventsFile)) {
        try {
            const parsed = JSON.parse(readFileSync(eventsFile, 'utf8')) as unknown;
            const list = (Array.isArray(parsed) ? parsed : (parsed as { events?: unknown[] }).events ?? []) as { endedAt: string; kind: string; result?: string }[];
            const events = list.filter(e => Date.parse(e.endedAt) >= since);
            const byKind: Record<string, number> = {};
            for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
            push(`账上行动 ${events.length} 件（${(events.length / days).toFixed(1)}/天）：${JSON.stringify(byKind)}；被打断 ${events.filter(e => e.result === 'interrupted').length}`);
        } catch { push('（账读不了）'); }
    } else push('（没有账）');

    // 日志里数到的
    const logDir = join(dataDir, 'logs');
    const counts: Record<string, number> = {};
    const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1; };
    const failures: number[] = [];
    const MARKS: [string, string][] = [
        ['心境：', '心境'], ['这一轮有意图：你刚推了他', '会拒绝·被磨时守着'], ['这一轮有意图：他在管着你', '会拒绝·被管着'], ['这一轮有意图：你刚约了他一起玩', '约他·他拒绝后轻松放下'],
        ['在做别的，', '延迟·分心'], ['图片表情：这一轮抽到', '图片表情·抽到'], ['照片货架：收了一张', '照片·收进货架'], ['照片货架：他想看', '照片·他要看'],
        ['陪玩：', '陪玩'], ['被打断：', '被打断'], ['小梗：这一轮', '小梗·放进提示词'], ['关系：', '关系阶段·放得开'], ['主动找他（约他一起玩', '主动·约他'], ['主动找他（问问他的意见', '主动·问意见'],
        ['主动找他（说了等下之后回来', '主动·等下之后回来'], ['回复失败', '回复失败'],
    ];
    if (existsSync(logDir)) {
        for (const file of readdirSync(logDir).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()) {
            if (Date.parse(file.slice(0, 10)) + DAY < since) continue;
            for (const line of readFileSync(join(logDir, file), 'utf8').split('\n')) {
                const m = /^\[(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)\]/.exec(line);
                if (m) {
                    const t = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime();
                    if (t < since) continue;
                    if (line.includes('回复失败') || line.includes('没连上模型')) failures.push(t);
                }
                for (const [needle, key] of MARKS) if (line.includes(needle)) bump(key);
            }
        }
    }
    push('\n## 日志里数到的（新功能有没有真的在发生）');
    push(Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join('；') || '（没有）');
    const clusters: { start: number; end: number }[] = [];
    for (const t of failures.sort((a, b) => a - b)) {
        const last = clusters.at(-1);
        if (last && t - last.end <= 30 * 60_000) last.end = t;
        else clusters.push({ start: t, end: t });
    }
    const downHours = clusters.reduce((sum, c) => sum + (c.end - c.start) / 3_600_000, 0);
    push(`\n## 在不在（下限）\n回复失败成 ${clusters.length} 次断，合计至少 ${downHours.toFixed(1)} 小时回不了话；最长一次 ${fmt(Math.max(0, ...clusters.map(c => (c.end - c.start) / 3_600_000)))} 小时。整机复位 / 日志里什么都没有的时间没算进去`);
    return `${out.join('\n')}\n`;
}

/** 这周的周报文件名：以“本周日”的本地日期命名（周日晚上出的那份） */
export function weeklyReportName(date: Date): string {
    const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
    const p = (n: number) => String(n).padStart(2, '0');
    return `weekly-${sunday.getFullYear()}-${p(sunday.getMonth() + 1)}-${p(sunday.getDate())}.md`;
}

/** 该不该出这周的了：周日 21:30 以后、这周的文件还没有 */
export function weeklyReportDue(now: Date, dir: string): boolean {
    if (now.getDay() !== 0) return false;
    if (now.getHours() * 60 + now.getMinutes() < 21 * 60 + 30) return false;
    return !existsSync(join(dir, weeklyReportName(now)));
}

/** 写这周的周报；返回文件路径 */
export function writeWeeklyReport(input: WeeklyReportInput & { reportsDir: string }): string {
    mkdirSync(input.reportsDir, { recursive: true });
    const file = join(input.reportsDir, weeklyReportName(new Date(input.now)));
    writeFileSync(file, weeklyReport(input), 'utf8');
    return file;
}
