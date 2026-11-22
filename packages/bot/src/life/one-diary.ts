// 一本日记（ADR 0347 第 3 层，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.5，开关 oneDiary，默认关）。
//
// 原来同一天她翻到哪篇，要看从哪个入口翻：selfThread、首轮铺底、做梦只读 JOURNAL.md，journalOn 读 JOURNAL.md 加 <<日记>>，
// 自我认识 / 心境回想的 readDiaries 三份都读（方案 §1.6）。用户 11-22 定了：QQ 是唯一写当天日记的一方，桌面只是她可以动手写几段的地方。
// 这里给开关开着时的统一读法，和三件配套的小事：
// 1. 读：oneDiaryEntries 走 readDiaries（JOURNAL.md 里她手写的段落、QQ 的当天日记、<<日记>>），
//    去掉 JOURNAL.md 里 QQ 自己抄过去的「（当天）」那份（和当天日记一字不差），同一天按「当天日记 > 手写 > <<日记>>」排；
//    latestDiary / diaryOnDate / diaryTail 分别给 selfThread + 首轮铺底、journalOn、做梦用。开关关着时调用方照旧读 JOURNAL.md，这里不碰。
// 2. 写日记的材料多一行「电脑上：…」（desktopDiaryLine）：只来自桌面回合的时间（切成会话）和时间线里 desktop 渠道的动作种类，
//    **不放桌面原文**——日记进公共库，同学档也召回得到（ADR 0177、方案 §2.8）。
// 3. QQ 写完当天日记，在 JOURNAL.md 末尾抄一份 `## YYYY-MM-DD（当天）`（appendDayDiary），桌面上 journal_read 不用改就读得到；一天只抄一次。
// 4. 常驻进程睡眠整合要不要再写 journal_write，看 NOW.md 的 `<!-- diary-by: qq -->`（DIARY_BY_LINE，渲染在 now-export.ts，契约见那边）。

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDiaries, WINDOW_DAYS, type DiaryDirs, type DiaryEntry } from './diary-insights.ts';
import { sessionsFromTurns, type PresenceTurn } from './desktop-presence.ts';
import type { Activity } from './schedule.ts';

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

/** 时间线里 desktop 渠道的动作种类 → 日记里的说法；不认识的种类不写（kind 是插件里模型填的，只认这几类，原文一概不碰） */
const ACTION_WORDS: ReadonlyArray<{ pattern: RegExp; word: string }> = [
    { pattern: /search|web|lookup|query|browse/i, word: '查了资料' },
    { pattern: /write|edit|draft|doc|note/i, word: '写了东西' },
    { pattern: /code|debug|fix|build|deploy|script/i, word: '弄了代码' },
    { pattern: /file|organi[sz]e|clean|sort|tidy/i, word: '整理了东西' },
    { pattern: /^read$|^read[_-](?!book)/i, word: '看了东西' },
    { pattern: /^action$|operate|device/i, word: '弄了点东西' },
];
/** 这些种类不是「帮他做的事」：记了一条长期记忆、会话本身（块 B 记的那条） */
const SKIP_KINDS = /^(?:memory_save|session)$/i;
/** 一段里最多写几种 */
const MAX_WORDS = 3;
/** 一天最多写几段（超了只留最长的几段，再按时间排） */
const MAX_SESSIONS = 4;
/** 动作的时刻落在会话前后这么久以内也算这一段的 */
const ACTION_SLACK_MS = 5 * 60_000;

export interface DesktopDiaryInput {
    /** 那一天（她的一天，到 02:00）的日期 YYYY-MM-DD */
    date: string;
    /** 某个时刻算她哪一天（formatDate(herDay(schedule, at))）：会话按开始的时刻归到那一天 */
    dayOf: (at: Date) => string;
    /** 桌面回合（desktopTurns(dataDir, now) 原样给就行）：这里只取 at / userAt，user / assistant 一个字都不读 */
    turns: readonly PresenceTurn[];
    /** 时间线里 desktop 渠道的事（只取时刻和种类，summary 不读） */
    actions?: readonly { at: number; kind: string }[];
    /** 会话开始时她作息上本来在干嘛（sessionOverlap 的同一个判断）；不给就不写「本来…」 */
    overlap?: (at: Date) => Activity['kind'] | undefined;
}

const hm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function actionWords(actions: readonly { at: number; kind: string }[], start: number, end: number): string[] {
    const words: string[] = [];
    for (const action of [...actions].sort((a, b) => a.at - b.at)) {
        if (!Number.isFinite(action.at) || action.at < start - ACTION_SLACK_MS || action.at > end + ACTION_SLACK_MS) continue;
        if (typeof action.kind !== 'string' || SKIP_KINDS.test(action.kind)) continue;
        const word = ACTION_WORDS.find(item => item.pattern.test(action.kind))?.word;
        if (word && !words.includes(word)) words.push(word);
        if (words.length >= MAX_WORDS) break;
    }
    return words;
}

/**
 * 日记材料里「电脑上：」那一行（没有会话返回 undefined）：
 * `电脑上：14:10–16:05 陪他（中间帮他查了资料、写了东西）；23:40–00:30 他叫你上电脑聊了会儿（本来该睡了）`。
 * 只有时刻、时长切出来的段、作息标签、固定的几种动作说法；桌面原文一个字都不进（日记进公共库）。
 */
export function desktopDiaryLine(input: DesktopDiaryInput): string | undefined {
    // 先把回合剥成只剩时间，后面的代码碰不到原文
    const times: PresenceTurn[] = input.turns.map(turn => ({ at: turn.at, ...(turn.userAt !== undefined ? { userAt: turn.userAt } : {}) }));
    const sessions = sessionsFromTurns(times).filter(session => input.dayOf(new Date(session.start)) === input.date);
    if (!sessions.length) return undefined;
    const kept = [...sessions].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start).slice(0, MAX_SESSIONS).sort((a, b) => a.start - b.start);
    const parts = kept.map(session => {
        const words = actionWords(input.actions ?? [], session.start, session.end);
        const kind = input.overlap?.(new Date(session.start));
        const span = `${hm(session.start)}–${hm(session.end)}`;
        if (kind === 'sleep') return `${span} 他叫你上电脑${words.length ? `，帮他${words.join('、')}` : '聊了会儿'}（本来该睡了）`;
        const inClass = kind === 'class';
        if (words.length) return `${span} 陪他（中间帮他${words.join('、')}${inClass ? '；本来在上课' : ''}）`;
        return `${span} 陪他聊了会儿${inClass ? '（本来在上课）' : ''}`;
    });
    return `电脑上：${parts.join('；')}`;
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
