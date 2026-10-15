// 反馈摘要（ADR 0073）：读 feedback/YYYY-MM.jsonl，按天数「假」「像」各几条，再列出被说「假」的那几轮（带前面两条上下文）。
// 只在终端打印，不写仓库：记录里有聊天原文，只该留在 runtime/。
// 用法：npm run feedback-digest -w packages/bot -- [--days 7] [--dir <数据目录，默认 runtime/bot>]

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedbackRow } from './feedback.ts';

export function readFeedback(dataDir: string): FeedbackRow[] {
    const dir = join(dataDir, 'feedback');
    if (!existsSync(dir)) return [];
    const rows: FeedbackRow[] = [];
    for (const name of readdirSync(dir).filter(file => /^\d{4}-\d{2}\.jsonl$/.test(file)).sort()) {
        for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line) as FeedbackRow;
                if ((row.label === 'fake' || row.label === 'real') && Number.isFinite(Date.parse(row.at)) && Array.isArray(row.her)) rows.push(row);
            } catch { /* 坏行跳过 */ }
        }
    }
    return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const dayOf = (iso: string) => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const clip = (text: string, max = 80) => { const chars = [...text.replace(/\s+/g, ' ')]; return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join(''); };

export function feedbackDigest(rows: readonly FeedbackRow[], now: Date, days: number): string {
    const since = now.getTime() - days * 86_400_000;
    const recent = rows.filter(row => Date.parse(row.at) >= since && Date.parse(row.at) <= now.getTime());
    const fake = recent.filter(row => row.label === 'fake');
    const real = recent.filter(row => row.label === 'real');
    const lines = [`# 反馈摘要（最近 ${days} 天）`, '', `共 ${recent.length} 条：假 ${fake.length}、像 ${real.length}`];
    if (!recent.length) return `${lines.join('\n')}\n\n这段时间没有反馈。\n`;

    const perDay = new Map<string, { fake: number; real: number }>();
    for (const row of recent) {
        const day = perDay.get(dayOf(row.at)) ?? { fake: 0, real: 0 };
        day[row.label]++;
        perDay.set(dayOf(row.at), day);
    }
    lines.push('', '| 日期 | 假 | 像 |', '| --- | --- | --- |');
    for (const [day, count] of [...perDay].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${day} | ${count.fake} | ${count.real} |`);

    if (fake.length) {
        lines.push('', '## 被说「假」的几轮（按时间）');
        for (const row of fake) {
            lines.push('', `- ${dayOf(row.at)} ${new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false })}　她：${row.her.map(bubble => `「${clip(bubble)}」`).join('')}`);
            for (const line of row.context.slice(-2)) lines.push(`  - 前文　${line.role === 'user' ? '他' : '她'}：${clip(line.text)}`);
        }
    }
    if (real.length) {
        lines.push('', '## 被说「像」的几轮（对照用）');
        for (const row of real) lines.push(`- ${dayOf(row.at)}　她：${row.her.map(bubble => `「${clip(bubble, 40)}」`).join('')}`);
    }
    return `${lines.join('\n')}\n`;
}
