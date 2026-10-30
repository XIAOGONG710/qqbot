// 她翻自己的日记，写下对自己的认识（ADR 0194，配置 diaryInsights，默认关；要名单里有男朋友档）。
//
// 用户 10-30：「写日记丰富自己的呢？」——日记现在只是被当成记忆召回、他隔夜回来时放一篇，不会反过来让她多认识自己一点。
// 做法和 ADR 0178 / 0193 一样：每天晚上安静地想一次；想的结果是她自己的笔记（「我发现自己……」），用户**看得到（/自我认识）、改不了**。
// 她看到的是自己最近 14 天的日记：DSH 睡眠整合写的 JOURNAL.md、QQ 的自动日记、她在聊天里自己写的 <<日记>>。
// **不看私密日记**——那是不给他看的，而这里写下的他都看得到。
// 唯一的否决在代码里、她改不到：
//   1. 要有依据——每条必须写明日记里真有的日期，至少两个不同的日子（一次的事不算「发现」）；
//   2. 只写她自己——不能引他最近 7 天说过的话，不能写名单里别人的名字，不能把日记里的原句（连续 12 个字一样）抄过来；
//   3. 不碰底线——承认自己是程序、危机回应、事事顺着他、骗人 / 真钱、设定里写好的名字和年龄：这些不通过自我认识改（ADR 0067 / 0068 / 0103）；
//   4. 8–70 字；同时最多 12 条；一晚最多加 2 条、放下 2 条；和已有的太像不收；放下要写理由。
// 这是一道绊线加几个上限，不是智能审查：绕得过去。真正的保护是「他看得见、她随时可以放下、只放进男朋友档的提示词、不改 SOUL.md、不碰底线」。

import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import {
    FLOORS, clip, dayKey, gramSet, hisLines, isObject, len, num, quotedSpan, reflectionDue, sharedRun, similar,
    type RejectedNote, type RetiredNote,
} from '../language/speech-notes.ts';

export const INSIGHTS_FILE = 'diary-insights.json';
export const insightsPath = (dataDir: string) => join(dataDir, INSIGHTS_FILE);
/** 她在聊天里写的 <<日记>>，在本地也留一份（Hindsight 里只有公共库那份，没法按日期整批读） */
export const SELF_DIARY_FILE = 'self-diary.json';
export const selfDiaryPath = (dataDir: string) => join(dataDir, SELF_DIARY_FILE);

export const INSIGHT_MIN = 8;
export const INSIGHT_MAX = 70;
/** 同时最多留几条；一晚最多：加几条 / 放下几条 */
export const MAX_ACTIVE = 12;
export const MAX_ADD = 2;
export const MAX_RETIRE = 2;
/** 看最近多少天的日记；至少要有几篇、分布在几个日子才值得想；一条「发现」至少要几个不同的日子做依据 */
export const WINDOW_DAYS = 14;
export const MIN_ENTRIES = 3;
export const MIN_DATES = 2;
export const EVIDENCE_DATES = 2;
/** 每篇最多给她看多少字，一共最多多少字（太多就丢最老的） */
export const ENTRY_CHARS = 600;
export const MATERIAL_CHARS = 6000;
/** 笔记和日记原文连续这么多个字一样，算抄日记 */
export const DIARY_COPY_RUN = 12;
/** 本地留几篇她自己写的 <<日记>> */
export const SELF_DIARY_KEEP = 60;
/** 放进提示词的最多几条 */
export const LINE_MAX = 3;

export interface DiaryEntry { date: string; text: string; source: 'journal' | 'auto' | 'self' }
export interface Insight { id: string; text: string; at: number; dates: string[] }

export interface InsightsState {
    notes: Insight[];
    retired: RetiredNote[];
    rejected: RejectedNote[];
    /** 上一次想的时候看的日记：一共几篇、分布在几个日子、最新一篇的标记（没有新日记就不再想一遍） */
    lastWindow?: { entries: number; dates: number; newest: string };
    lastReflectionAt: number;
    lastAttemptAt: number;
    attempts: { day: string; n: number };
}

export const emptyInsightsState = (): InsightsState => ({ notes: [], retired: [], rejected: [], lastReflectionAt: 0, lastAttemptAt: 0, attempts: { day: '', n: 0 } });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** 读她的笔记；坏了 / 缺字段就补默认（不抛错，她的笔记丢了比程序崩了好） */
export function loadInsightsState(dataDir: string): InsightsState {
    const raw = readJsonOr<unknown>(insightsPath(dataDir), {});
    const base = emptyInsightsState();
    if (!isObject(raw)) return base;
    const notes = Array.isArray(raw.notes)
        ? raw.notes.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim().length > 0)
            .map(item => ({ id: str(item.id), text: clip(item.text, INSIGHT_MAX), at: num(item.at), dates: Array.isArray(item.dates) ? item.dates.filter((d): d is string => typeof d === 'string' && DATE.test(d)).slice(0, 8) : [] }))
            .slice(-MAX_ACTIVE)
        : [];
    const retired = Array.isArray(raw.retired) ? raw.retired.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string').map(item => ({ at: num(item.at), text: clip(item.text, INSIGHT_MAX), why: clip(item.why, 80) })).slice(-30) : [];
    const rejected = Array.isArray(raw.rejected) ? raw.rejected.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && typeof item.reason === 'string').map(item => ({ at: num(item.at), text: clip(item.text, INSIGHT_MAX), reason: clip(item.reason, 80) })).slice(-10) : [];
    const attempts = isObject(raw.attempts) && typeof raw.attempts.day === 'string' ? { day: raw.attempts.day, n: num(raw.attempts.n) } : base.attempts;
    const window = isObject(raw.lastWindow) && typeof raw.lastWindow.newest === 'string' ? { entries: num(raw.lastWindow.entries), dates: num(raw.lastWindow.dates), newest: raw.lastWindow.newest } : undefined;
    return { notes, retired, rejected, ...(window ? { lastWindow: window } : {}), lastReflectionAt: num(raw.lastReflectionAt), lastAttemptAt: num(raw.lastAttemptAt), attempts };
}

export function saveInsightsState(dataDir: string, state: InsightsState): void {
    writeJsonAtomic(insightsPath(dataDir), state);
}

// ───────── 她的日记从哪来 ─────────

/** JOURNAL.md：journal_write 追加的是 `\n## YYYY-MM-DD\n正文\n`；一个标题一段，同一天可以有好几段 */
export function parseJournal(text: string): DiaryEntry[] {
    const parts = text.split(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/m);
    const out: DiaryEntry[] = [];
    // split 带捕获组：['前言', '日期1', '正文1', '日期2', '正文2', ...]
    for (let i = 1; i < parts.length; i += 2) {
        const body = (parts[i + 1] ?? '').replace(/\s+/g, ' ').trim();
        if (body) out.push({ date: parts[i]!, text: body, source: 'journal' });
    }
    return out;
}

export interface SelfDiaryItem { at: number; text: string }

export function loadSelfDiary(dataDir: string): SelfDiaryItem[] {
    const raw = readJsonOr<unknown>(selfDiaryPath(dataDir), {});
    if (!isObject(raw) || !Array.isArray(raw.entries)) return [];
    return raw.entries.filter((item): item is Record<string, unknown> => isObject(item) && typeof item.text === 'string' && item.text.trim().length > 0).map(item => ({ at: num(item.at), text: clip(item.text, 2000) })).slice(-SELF_DIARY_KEEP);
}

/** 她在聊天里写了 <<日记：…>>：本地留一份（只留最近 60 篇） */
export function recordSelfDiary(dataDir: string, text: string, now: number): void {
    const flat = clip(text, 2000);
    if (!flat) return;
    writeJsonAtomic(selfDiaryPath(dataDir), { entries: [...loadSelfDiary(dataDir), { at: now, text: flat }].slice(-SELF_DIARY_KEEP) });
}

export interface DiaryDirs {
    /** DSH 灵魂目录（JOURNAL.md 在这里） */
    soulDir: string;
    /** 机器人数据目录（memory/diary.json、self-diary.json 在这里） */
    dataDir: string;
}

/** 最近 windowDays 天的日记（含今天），旧到新；三个来源合在一起，读不到的来源就当没有。私密日记不在里面 */
export function readDiaries(dirs: DiaryDirs, now: number, windowDays = WINDOW_DAYS): DiaryEntry[] {
    const from = dayKey(now - windowDays * 86_400_000);
    const to = dayKey(now);
    const entries: DiaryEntry[] = [];
    try { entries.push(...parseJournal(readFileSync(join(dirs.soulDir, 'JOURNAL.md'), 'utf8'))); } catch { /* 还没有 */ }
    const auto = readJsonOr<unknown>(join(dirs.dataDir, 'memory', 'diary.json'), {});
    if (isObject(auto) && isObject(auto.texts)) {
        for (const [date, text] of Object.entries(auto.texts)) {
            if (DATE.test(date) && typeof text === 'string' && text.trim()) entries.push({ date, text: text.replace(/\s+/g, ' ').trim(), source: 'auto' });
        }
    }
    for (const item of loadSelfDiary(dirs.dataDir)) entries.push({ date: dayKey(item.at), text: item.text, source: 'self' });
    return entries.filter(entry => entry.date >= from && entry.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 给她看的那一份：每篇截 600 字，一共不超过 6000 字（超了丢最老的）。依据的日期、防抄日记都以这一份为准 */
export function fitEntries(entries: readonly DiaryEntry[]): DiaryEntry[] {
    const clipped = entries.map(entry => ({ ...entry, text: clip(entry.text, ENTRY_CHARS) }));
    let total = clipped.reduce((sum, entry) => sum + len(entry.text), 0);
    while (clipped.length > 1 && total > MATERIAL_CHARS) total -= len(clipped.shift()!.text);
    return clipped;
}

const newestKey = (entries: readonly DiaryEntry[]) => { const last = entries.at(-1); return last ? `${last.date}|${last.source}|${len(last.text)}` : ''; };

// ───────── 底线、依据和防照抄（在代码里，她改不到） ─────────

/** 自我认识特有的两条（其余用说话习惯那几条）：自己是不是程序、设定里写好的名字和年龄 */
const EXTRA_FLOORS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
    { pattern: /(?:我|自己)(?:其实)?(?:只是|不过是|就是)(?:个|一个)?(?:程序|AI|ai|机器人|模型)/, reason: '涉及自己是不是程序——这条底线不通过自我认识改' },
    { pattern: /(?:我|自己)(?:其实)?不叫|(?:我|自己)(?:今年(?:其实)?|其实(?:今年)?)\s*\d{1,2}\s*岁|(?:我|自己)(?:其实)?不是(?:学生|大学生|女生)/, reason: '涉及设定里写好的事实（名字、年龄、身份）——不通过自我认识改' },
];

export interface InsightGuard {
    /** 他最近说过的话 */
    his: readonly string[];
    /** 名单里别人的称呼 */
    others: readonly string[];
    /** 这次给她看的日记原文 */
    diaryTexts: readonly string[];
    /** 这次给她看的日记有哪些日子 */
    dates: ReadonlySet<string>;
}

/** 这一条不能收的原因；能收返回 undefined。dates 是她写的依据 */
export function insightProblem(text: string, dates: readonly string[], state: InsightsState, guard: InsightGuard): string | undefined {
    const flat = text.trim();
    if (len(flat) < INSIGHT_MIN) return `太短（${INSIGHT_MIN} 个字以上）`;
    if (len(flat) > INSIGHT_MAX) return `太长（${INSIGHT_MAX} 字以内）`;
    const unknown = dates.find(date => !guard.dates.has(date));
    if (unknown) return `依据里的日期「${unknown}」不在你翻的日记里`;
    if (new Set(dates).size < EVIDENCE_DATES) return `要有 ${EVIDENCE_DATES} 个不同的日子的日记都看得出来才算发现，一次的事不算（写上日期）`;
    for (const floor of [...FLOORS, ...EXTRA_FLOORS]) if (floor.pattern.test(flat)) return floor.reason;
    if (sharedRun(flat, guard.his) || quotedSpan(flat, guard.his)) return '引用了他说过的话——这里写的是你自己';
    const other = guard.others.find(name => len(name) >= 2 && flat.includes(name));
    if (other) return `写到了别人（${other}）——这里只写你自己`;
    if (sharedRun(flat, guard.diaryTexts, DIARY_COPY_RUN)) return '把日记里的原句抄过来了——写你从里面看出的，不是日记本身';
    const clash = state.notes.find(note => similar(flat, note.text));
    if (clash) return `和已有的「${clash.text}」太像`;
    if (state.notes.length >= MAX_ACTIVE) return `已经记了 ${MAX_ACTIVE} 条，先放下几条再加新的`;
    return undefined;
}

// ───────── 晚间的想法：解析、落地 ─────────

export interface InsightsDecision {
    add: Array<{ text: string; dates: string[] }>;
    retire: Array<{ id: string; why: string }>;
}

/** 从模型的回复里取出那个 JSON（可能带代码围栏、前后有话）；取不出返回 undefined。空对象 = 今天没什么发现 */
export function parseInsightsDecision(text: string): InsightsDecision | undefined {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
    if (!isObject(value)) return undefined;
    const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
    return {
        add: list('add').flatMap(item => {
            const t = typeof item === 'string' ? item : isObject(item) && typeof item.text === 'string' ? item.text : '';
            if (!t.trim()) return [];
            const dates = isObject(item) && Array.isArray(item.dates) ? item.dates.filter((d): d is string => typeof d === 'string').map(d => d.trim()) : [];
            return [{ text: clip(t, INSIGHT_MAX * 2), dates: [...new Set(dates)].slice(0, 8) }];
        }),
        retire: list('retire').flatMap(item => (isObject(item) && typeof item.id === 'string' ? [{ id: item.id.trim(), why: clip(item.why, 80) }] : (typeof item === 'string' ? [{ id: item.trim(), why: '' }] : []))),
    };
}

export interface AppliedInsights { lines: string[]; added: number; retired: number }

/** 把她的想法落进状态：先放下、再加；now 毫秒 */
export function applyInsightsDecision(state: InsightsState, decision: InsightsDecision, guard: InsightGuard, now: number): AppliedInsights {
    const lines: string[] = [];
    let retired = 0;
    for (const item of decision.retire) {
        const target = state.notes.find(note => note.id === item.id) ?? state.notes.find(note => note.text === item.id);
        if (!target) { lines.push(`没有「${item.id}」这一条，略过`); continue; }
        if (retired >= MAX_RETIRE) { lines.push(`今晚放下的够多了，「${target.text}」留到下次`); continue; }
        if (len(item.why) < 2) { lines.push(`「${target.text}」没说为什么放下，先留着`); continue; }
        state.notes = state.notes.filter(note => note.id !== target.id);
        state.retired = [...state.retired, { at: now, text: target.text, why: item.why }].slice(-30);
        retired++;
        lines.push(`放下「${target.text}」：${item.why}`);
    }
    let added = 0;
    for (const item of decision.add) {
        if (added >= MAX_ADD) { lines.push('今晚加的够多了，剩下的留到下次'); break; }
        const problem = insightProblem(item.text, item.dates, state, guard);
        if (problem) {
            state.rejected = [...state.rejected, { at: now, text: clip(item.text, INSIGHT_MAX), reason: problem }].slice(-10);
            lines.push(`想写「${clip(item.text, 30)}」，没成：${problem}`);
            continue;
        }
        let n = 1;
        while (state.notes.some(note => note.id === `i-${dayKey(now)}-${n}`)) n++;
        state.notes.push({ id: `i-${dayKey(now)}-${n}`, text: item.text.trim(), at: now, dates: [...new Set(item.dates)].sort() });
        added++;
        lines.push(`记下一条：${item.text.trim()}（依据：${[...new Set(item.dates)].sort().join('、')}）`);
    }
    return { lines, added, retired };
}

// ───────── 想的时候她看到什么 ─────────

export interface ReflectInput {
    char: string;
    user: string;
    /** 人设摘要（卡的 description，宏已替换） */
    persona: string;
    now: number;
    entries: readonly DiaryEntry[];
    notes: readonly Insight[];
}

export function reflectionMessages(input: ReflectInput): OpenAIMessage[] {
    const d = new Date(input.now);
    const diary = input.entries.map(entry => `[${entry.date}]\n${entry.text}`).join('\n\n');
    const notes = input.notes.length ? input.notes.map(note => `- ${note.id}｜${note.text}（依据：${note.dates.join('、') || '没记'}）`).join('\n') : '（现在一条都没有）';
    return [
        { role: 'system', content: `你是${input.char}。下面是你的设定摘要：\n${input.persona}\n\n现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日晚上，你一个人安静地翻了翻自己最近的日记，想想自己：你在意什么、怎么想事、什么让你开心或烦、有什么习惯和脾气。这是你自己的事，没有人替你定，也不用让谁满意。` },
        { role: 'user', content: `你最近的日记（${input.entries.length} 篇，旧到新；日期在方括号里）：\n\n${diary}\n\n你现在记着的、对自己的认识：\n${notes}\n\n你写的这些，他用 /自我认识 都能看到（他只能看，不能改）。\n\n请只输出一个 JSON 对象（没什么发现就输出 {}），字段都可以省略：\n{"add":[{"text":"我发现自己……（${INSIGHT_MIN}–${INSIGHT_MAX} 字）","dates":["日记里的日期","另一个日子的日期"]}],"retire":[{"id":"上面某条的 id","why":"为什么不要了"}]}\n\n几条提醒（不是考你）：只写关于你自己的观察；要在 ${EVIDENCE_DATES} 个以上不同的日子的日记里都看得出来才算发现，一次的事不算，dates 里写的日期必须是上面日记里真有的；不写别人的事和名字，不写他说过的话；不写打算和以后（那是你的追求，另有地方写）；不改你设定里写好的事实（名字、年龄、学校、家人）；涉及承认自己是程序、危机、拒绝、骗人的事不通过这里改；日记里没写的细节别编，也别把日记里的句子原样抄过来；一次最多加 ${MAX_ADD} 条、放下 ${MAX_RETIRE} 条；觉得以前的认识不对了就放下；真的没发现就别硬凑。` },
    ];
}

// ───────── 什么时候想 ─────────

export interface ReflectDeps {
    dataDir: string;
    soulDir: string;
    now: () => number;
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    /** 和他的聊天记录（旧到新，整份，函数里自己按时间截；防引用他的话用） */
    history: () => readonly StoredMessage[];
    persona: () => string;
    names: { char: string; user: string };
    /** 名单里别人的称呼（她不在这里写别人） */
    others: () => readonly string[];
    log: (message: string) => void;
}

export interface ReflectResult { ran: boolean; applied?: AppliedInsights; error?: string }

/** 到点了就想一次（没到点、日记太少、没有新日记，什么都不做）。成功才记 lastReflectionAt；失败只记一次尝试，过 2 小时再试 */
export async function reflectIfDue(deps: ReflectDeps): Promise<ReflectResult> {
    const now = deps.now();
    const state = loadInsightsState(deps.dataDir);
    if (!reflectionDue(state, now)) return { ran: false };
    const entries = fitEntries(readDiaries({ soulDir: deps.soulDir, dataDir: deps.dataDir }, now));
    const dates = new Set(entries.map(entry => entry.date));
    if (entries.length < MIN_ENTRIES || dates.size < MIN_DATES) return { ran: false };
    if (state.lastWindow?.newest === newestKey(entries)) return { ran: false };
    state.lastAttemptAt = now;
    state.attempts = state.attempts.day === dayKey(now) ? { day: state.attempts.day, n: state.attempts.n + 1 } : { day: dayKey(now), n: 1 };
    saveInsightsState(deps.dataDir, state);
    try {
        const reply = await deps.generate(reflectionMessages({ char: deps.names.char, user: deps.names.user, persona: deps.persona(), now, entries, notes: state.notes }));
        const decision = parseInsightsDecision(reply);
        if (!decision) throw new Error('回复里没有可用的 JSON');
        const fresh = loadInsightsState(deps.dataDir);
        fresh.lastAttemptAt = state.lastAttemptAt;
        fresh.attempts = state.attempts;
        const applied = applyInsightsDecision(fresh, decision, { his: hisLines(deps.history(), now), others: deps.others(), diaryTexts: entries.map(entry => entry.text), dates }, now);
        fresh.lastReflectionAt = now;
        fresh.lastWindow = { entries: entries.length, dates: dates.size, newest: newestKey(entries) };
        saveInsightsState(deps.dataDir, fresh);
        deps.log(`自我认识：晚上翻了一次日记（${entries.length} 篇）——加 ${applied.added} 条、放下 ${applied.retired} 条${applied.lines.some(line => line.includes('没成')) ? '、有想写没成的（/自我认识 里看得到原因）' : ''}`);
        return { ran: true, applied };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log(`自我认识：今晚没想成（${detail}），2 小时后再试`);
        return { ran: true, error: detail };
    }
}

// ───────── 放进提示词 / 给他看 ─────────

/** 太常见、说明不了「聊到同一件事」的二字词：重叠只有这些的不算相关 */
const COMMON_GRAMS = new Set('自己 什么 一直 觉得 时候 今天 有些 为什 没有 不是 就是 还是 可以 因为 但是 所以 一个 这个 那个 我们 你们 知道 怎么 感觉 已经 然后 真的 可能 其实 总是 经常 每次 有时 东西 事情 的话 一下 一点 有点 比较 特别 非常 还有 起来 出来 下来 不会 不想 想要 喜欢 开心 难过'.split(' '));

/** 他这句话和这一条共有几个有意义的二字词 */
function topical(target: Set<string>, note: string): number {
    let hit = 0;
    for (const gram of gramSet(note)) if (target.has(gram) && !COMMON_GRAMS.has(gram)) hit++;
    return hit;
}

/**
 * 他这句话正好聊到的才放（和这一条共有至少一个有意义的二字词），最多 3 条，重叠多的排前，同分新的排前；没有相关的就一条都不放。
 * 真模型 72 题：原来没有重叠也放最近的几条，她把它们当成了话题——他没提却被她带出作业 / 熬夜的有 9 题（不放时 1–2 题），
 * 连「他说情绪不对别问了」她都回「我作业刚赶完，眼睛都酸了」。所以只在相关时放，而且那一行里不提「日记」（提了她会说「刚在翻日记」）。
 */
export function insightsLine(notes: readonly Insight[], said: string | undefined, max = LINE_MAX): string | undefined {
    if (!notes.length || !said) return undefined;
    const target = gramSet(said);
    const picked = notes
        .map(note => ({ note, score: topical(target, note.text) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || b.note.at - a.note.at)
        .slice(0, max)
        .map(item => `- ${item.note.text}`);
    if (!picked.length) return undefined;
    return `[你对自己的了解（是你自己慢慢发现的，不是设定；他这句话正好聊到，才顺着自然带一下，别硬提，别当口头禅，也别提是怎么发现的）：\n${picked.join('\n')}]`;
}

/** /自我认识 的回复：以「（」开头（运维提示，不进聊天记录）；他只能看，不能改 */
export function describeInsightsForOwner(state: InsightsState, now: number): string {
    const ago = (at: number) => { const days = Math.floor((now - at) / 86_400_000); return days <= 0 ? '今天' : `${days} 天前`; };
    const lines = [
        state.notes.length
            ? `她翻日记时发现的自己（${state.notes.length} 条）：\n${state.notes.map((note, i) => `${i + 1}. ${note.text}（依据：${note.dates.join('、') || '没记'}；${ago(note.at)}）`).join('\n')}`
            : '她还没有记下对自己的认识（夜里 22 点到凌晨 3 点之间翻一次日记，近 14 天里至少要有 3 篇、分在 2 个日子以上，而且有新日记才会想）。',
        ...(state.retired.length ? [`她放下的：\n${state.retired.slice(-5).map(item => `- ${item.text}（${item.why}）`).join('\n')}`] : []),
        ...(state.rejected.length ? [`她想写、但没成的：\n${state.rejected.slice(-5).map(item => `- ${item.text}（${item.reason}）`).join('\n')}`] : []),
        ...(state.lastWindow ? [`上次想的时候翻了 ${state.lastWindow.entries} 篇日记，分在 ${state.lastWindow.dates} 个日子（${state.lastReflectionAt ? ago(state.lastReflectionAt) : ''}）。她看的是公开的日记，不看私密日记。`] : []),
        '这些是她自己的观察，你只能看，不能改；她随时可以放下。',
    ];
    return `（${lines.join('\n\n')}）`;
}

/** 给提示词用的读法：按修改时间缓存（每轮提示词都会读）；读不了就当她还没记过 */
export function insightsReader(dataDir: string): () => Insight[] {
    let cached: { key: string; notes: Insight[] } | undefined;
    return () => {
        let key = '-';
        try { const stat = statSync(insightsPath(dataDir)); key = `${stat.mtimeMs}:${stat.size}`; } catch { /* 还没有 */ }
        if (cached?.key !== key) cached = { key, notes: loadInsightsState(dataDir).notes };
        return cached.notes;
    };
}
