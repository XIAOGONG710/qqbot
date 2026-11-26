// 一本日记（ADR 0347 第 3 层，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.5，开关 oneDiary，默认关）。
//
// 原来同一天她翻到哪篇，要看从哪个入口翻：selfThread、首轮铺底、做梦只读 JOURNAL.md，journalOn 读 JOURNAL.md 加 <<日记>>，
// 自我认识 / 心境回想的 readDiaries 三份都读（方案 §1.6）。用户 11-22 定了：QQ 是唯一写当天日记的一方，桌面只是她可以动手写几段的地方。
// 这里给开关开着时的统一读法，和三件配套的小事：
// 1. 读：oneDiaryEntries 走 readDiaries（JOURNAL.md 里她手写的段落、QQ 的当天日记、<<日记>>），
//    去掉 JOURNAL.md 里 QQ 自己抄过去的「（当天）」那份（和当天日记一字不差），同一天按「当天日记 > 手写 > <<日记>>」排；
//    latestDiary / diaryOnDate / diaryTail 分别给 selfThread + 首轮铺底、journalOn、做梦用。开关关着时调用方照旧读 JOURNAL.md，这里不碰。
// 2. 当天日记只接收她主动选写、并愿意公开的桌面摘要（日记进公共库）。
// 3. QQ 写完当天日记，在 JOURNAL.md 末尾抄一份 `## YYYY-MM-DD（当天）`（appendDayDiary），桌面上 journal_read 不用改就读得到；一天只抄一次。
// 4. 常驻进程睡眠整合要不要再写 journal_write，看 NOW.md 的 `<!-- diary-by: qq -->`（DIARY_BY_LINE，渲染在 now-export.ts，契约见那边）。

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDiaries, WINDOW_DAYS, type DiaryDirs, type DiaryEntry } from './diary-insights.ts';

// ───────── 读：一本日记 ─────────

/** 同一天谁排前面：当天日记（QQ 写的）> JOURNAL.md 里手写的 > 聊天里写的 <<日记>> */
const RANK: Record<DiaryEntry['source'], number> = { auto: 0, journal: 1, self: 2 };

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * 最近 windowDays 天（含今天）的日记，一本：旧到新，同一天当天日记排最前。
 * JOURNAL.md 里和当天日记一字不差的那段（appendDayDiary 抄过去的「（当天）」）去掉，免得同一篇算两次。
 */
export function oneDiaryEntries(dirs: DiaryDirs, now: number, windowDays = WINDOW_DAYS): DiaryEntry[] {
    const entries = readDiaries(dirs, now, windowDays);
    const autos = new Set(entries.filter(entry => entry.source === 'auto').map(entry => `${entry.date}|${flat(entry.text)}`));
    return entries
        .filter(entry => entry.source !== 'journal' || !autos.has(`${entry.date}|${flat(entry.text)}`))
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => (a.entry.date < b.entry.date ? -1 : a.entry.date > b.entry.date ? 1 : RANK[a.entry.source] - RANK[b.entry.source] || a.index - b.index))
        .map(item => item.entry);
}

/** 聊天提示词只读桌面手写段落，跳过合并了不同联系人材料的当天成稿。 */
export function handwrittenDiaryEntries(dirs: DiaryDirs, now: number, windowDays = WINDOW_DAYS): DiaryEntry[] {
    return oneDiaryEntries(dirs, now, windowDays).filter(entry => entry.source === 'journal');
}

/** 最近的那一天、排第一的那篇（给 selfThread、首轮铺底）；没有返回 undefined */
export function latestDiary(entries: readonly DiaryEntry[]): { date: string; text: string } | undefined {
    const last = entries.at(-1);
    if (!last) return undefined;
    const first = entries.find(entry => entry.date === last.date && flat(entry.text));
    return first ? { date: first.date, text: flat(first.text) } : undefined;
}

/** 某一天的日记（journalOn 的一本日记版）：当天日记在前，再是手写的、<<日记>>；压到 maxChars 字以内（太长取开头）。没有返回 undefined */
export function diaryOnDate(entries: readonly DiaryEntry[], date: string, maxChars = 220): string | undefined {
    const texts = entries.filter(entry => entry.date === date).map(entry => flat(entry.text)).filter(Boolean);
    if (!texts.length) return undefined;
    const joined = texts.join(' ／ ');
    return [...joined].length > maxChars ? `${[...joined].slice(0, maxChars).join('')}……` : joined;
}

/** 他问到的那一天要能读到：readDiaries 的窗口按那一天往回算（至少 WINDOW_DAYS） */
export function windowFor(date: string, now: number): number {
    const at = Date.parse(`${date}T12:00:00`);
    if (!Number.isFinite(at)) return WINDOW_DAYS;
    return Math.max(WINDOW_DAYS, Math.ceil((now - at) / 86_400_000) + 1);
}

/** 做梦 / 学习问题要的「日记尾巴」：按 JOURNAL.md 的样子排出来，取最后 maxChars 个字符（和原来 slice(-n) 一样） */
export function diaryTail(entries: readonly DiaryEntry[], maxChars: number): string {
    const text = entries.map(entry => `## ${entry.date}\n${flat(entry.text)}`).join('\n\n');
    return text.slice(-maxChars);
}

// ───────── 写日记的材料：电脑上那几段 ─────────

const DIARY_CHOICE = /【聊完还在想，也想写进今天的日记[：:]([^【】\r\n]+)】/g;

export interface DesktopDiaryInput {
    date: string;
    dayOf: (at: Date) => string;
    turns: readonly { at: number; assistant: string }[];
}

/** 只收她自己单独写下、愿意进公开日记的摘要。整场对话和活动时段都不是选记。 */
export function desktopDiaryLine(input: DesktopDiaryInput): string | undefined {
    const notes = new Set<string>();
    for (const turn of input.turns) {
        if (input.dayOf(new Date(turn.at)) !== input.date) continue;
        for (const match of turn.assistant.matchAll(DIARY_CHOICE)) {
            const note = match[1]?.trim();
            if (note && !note.endsWith('…')) notes.add(note);
        }
    }
    return notes.size ? `电脑上你想留下的事：${[...notes].slice(0, 4).join('；')}` : undefined;
}

// ───────── JOURNAL.md：抄一份当天日记给桌面看 ─────────

/** 抄过去的段落标题后面带这个，桌面那边的 journal_read 照常读（它只跳过「补记」） */
export const DAY_DIARY_MARK = '（当天）';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** JOURNAL.md 里是不是已经有那天抄过去的一段 */
export function hasDayDiary(journal: string, date: string): boolean {
    return new RegExp(`^##\\s+${escape(date)}[^\\n]*${escape(DAY_DIARY_MARK)}`, 'm').test(journal);
}

/** 文件操作（测试里可以换） */
export interface JournalOps {
    /** 没有这个文件返回 undefined，别的错误照抛 */
    read(path: string): string | undefined;
    append(path: string, text: string): void;
}

export const journalOps: JournalOps = {
    read(path) {
        try { return readFileSync(path, 'utf8'); } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
            throw error;
        }
    },
    append(path, text) { appendFileSync(path, text); },
};

/**
 * QQ 写完那天的日记以后，在 JOURNAL.md 末尾追加 `## YYYY-MM-DD（当天）` + 正文（和 journal_write 一样的格式）。
 * 已经有那天的「（当天）」段落就不再写（一天一次，重启 / 补写都安全）；她在桌面上 journal_write 写的段落原样留着。
 * 正文里以 # 开头的行去掉井号，免得切段时被当成新的一天。写了返回 true。
 */
export function appendDayDiary(soulDir: string, date: string, text: string, ops: JournalOps = journalOps): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const body = text.replace(/\r\n?/g, '\n').replace(/^#+[ \t]*/gm, '').trim();
    if (!body) return false;
    const path = join(soulDir, 'JOURNAL.md');
    const journal = ops.read(path) ?? '';
    if (hasDayDiary(journal, date)) return false;
    const lead = journal && !journal.endsWith('\n') ? '\n' : '';
    ops.append(path, `${lead}\n## ${date}${DAY_DIARY_MARK}\n${body}\n`);
    return true;
}
