import { localDate } from '../local-date.ts';
// 记忆变淡、一提就想起（ADR 0018 决策 1）：召回之后、整理成一段之前，给每条算现在还记得多清楚。
// - 长期知道的不变淡：Hindsight 写入时在事实开头标了【长期】（偏好、习惯、他是做什么的、一直在做的事）或【重要】的
//   （整合成观察后标记会丢，所以也看观察背后的事实），还没到日子的计划。日记、周记、阶段总结里的【长期】不算，按那段时间。
// - 某天的事按「最后一次沾到它」到今天过了几天：发生的日子和最后一次被提起的日子取晚的（他又说起一次就算重新记了一遍）；
//   Hindsight 只给原话里带时间词的写发生日期，没写的按哪天说的（实现时的调整 11）；
//   日记按那篇的日子，周记、阶段总结按最后一天。CLEAR_DAYS 以内清楚，VAGUE_DAYS 以内记个大概，再早的想不起来；
//   提过 2 次以上（观察背后有 2 条以上事实）的、周记和阶段总结（整段的大概记得更久）期限翻倍。
// - 想不起来的，他这次的话（她上次回复之后的）里出现了这条的某个实体名（至少 2 个字，不算她和名单里的称呼）就想起来，细节按记个大概说；
//   问到那一周、那个假期（window）时，那段时间的周记、阶段总结也算一提就想起。

import { EPISODE_GAP_MS } from './episodes.ts';
import type { RecallResult } from './hindsight.ts';
import { calendarDate } from './state-schema.ts';
import { civilDayInWindow, civilDayNumber, providerTime } from './civil-time.ts';

/** 只提过一次的：几天以内清楚、几天以内记个大概 */
export const CLEAR_DAYS = 7;
export const VAGUE_DAYS = 30;
/** 提示词里的原始聊天最多几条（ADR 0036 决策 3） */
export const RAW_MESSAGES = 80;
/** Hindsight 写入时给重要的事标的记号（写入说明里的规则，见 long-term.ts 的 missions） */
export const IMPORTANT = '【重要】';
/** 一直成立的事（偏好、习惯、身份、一直在做的事）的记号，同上 */
export const LASTING = '【长期】';

/** lasting 长期知道的；clear 清楚；vague 记个大概；recognized 本来想不起来，他一提想起来了；forgotten 想不起来 */
export type Clarity = 'lasting' | 'clear' | 'vague' | 'recognized' | 'forgotten';

export interface FadeOptions {
    now: Date;
    /** 他这次说的话（她上次回复之后的） */
    heard: string;
    /** 不算「一提就想起」的名字：她的、名单里的称呼（提到鸽鸽不等于想起鸽鸽的每件旧事） */
    ignore: readonly string[];
    /** 他问的那段时间（people.ts 的 askedWindow）：这段时间里的周记、阶段总结算一提就想起 */
    window?: { start: Date; end: Date };
}

/** 一次召回里记个大概、一提想起、想不起来各几条（日志用） */
export interface FadeStats {
    vague: number;
    recognized: number;
    forgotten: number;
    /** 同一个人和事放够了、没放的（long-term.ts SAME_THING_RECALLED） */
    repeated?: number;
}

const DAY_MS = 86_400_000;
const MIN_NAME_CHARS = 2;
/** 按那篇的日子算的文档：日记（diary:<那天>）、周记（week:<周一>，算到周日）、阶段总结（phase:<假期名>:<最后一天>） */
const DATED_DOCUMENT = /^(diary|week|phase:[^:]+):(\d{4})-(\d{2})-(\d{2})$/;

/** 周记、阶段总结（ADR 0018 决策 3） */
export function isSummary(result: RecallResult): boolean {
    return /^(week|phase):/.test(result.document_id ?? '');
}

const time = providerTime;

/** 开头的记号（两个都标时是「【重要】【长期】」） */
const MARKS = /^\s*((?:【重要】|【长期】)+)/;

/** 自己开头有这个记号，或者背后的事实有 */
function marked(result: RecallResult, mark: string): boolean {
    return [result.text, ...(result.sources ?? [])].some(text => MARKS.exec(text)?.[1]!.includes(mark) ?? false);
}

/** 重要的（【重要】） */
export function isImportant(result: RecallResult): boolean {
    return marked(result, IMPORTANT);
}

/** 一直成立的（【长期】）；日记、周记、阶段总结里的不算 */
export function isLasting(result: RecallResult): boolean {
    return !DATED_DOCUMENT.test(result.document_id ?? '') && marked(result, LASTING);
}

/** 去掉【重要】【长期】记号（放进提示词前） */
export function withoutMark(text: string): string {
    return text.replaceAll(IMPORTANT, '').replaceAll(LASTING, '').trim();
}

/**
 * 最后一次沾到它的时间：日记按那篇的日子；别的取发生、结束、最后一次被提起里最晚的（没有发生日期的就是哪天说的）。
 * 一个时间都没有返回 undefined
 */
export function lastTouched(result: RecallResult): Date | undefined {
    const document = DATED_DOCUMENT.exec(result.document_id ?? '');
    if (document && calendarDate(`${document[2]}-${document[3]}-${document[4]}`)) {
        return localDate(Number(document[2]), Number(document[3]) - 1, Number(document[4]) + (document[1] === 'week' ? 6 : 0));
    }
    const times = [result.occurred_start, result.occurred_end, result.mentioned_at].map(time).filter(t => t !== undefined);
    return times.length ? new Date(Math.max(...times)) : undefined;
}

/** Document dates are civil labels, including dates absent from the host timezone. */
export function lastTouchedDay(result: RecallResult): number | undefined {
    const document = DATED_DOCUMENT.exec(result.document_id ?? '');
    if (document) {
        const day = civilDayNumber(`${document[2]}-${document[3]}-${document[4]}`);
        if (day !== undefined) return day + (document[1] === 'week' ? 6 : 0);
    }
    const touched = lastTouched(result);
    return touched ? civilDayNumber(touched) : undefined;
}

/** 他这次的话里有没有这条的某个实体名 */
function recognizes(result: RecallResult, options: FadeOptions): boolean {
    return (result.entities ?? []).some(name => {
        // 只需知道是否至少两个代码点，不为大实体创建等长字符数组。
        let count = 0;
        for (const _char of name) { if (++count >= MIN_NAME_CHARS) break; }
        return count >= MIN_NAME_CHARS && !options.ignore.includes(name) && options.heard.includes(name);
    });
}

/** 这条现在还记得多清楚 */
export function clarity(result: RecallResult, options: FadeOptions): Clarity {
    if (isImportant(result) || isLasting(result)) return 'lasting';
    // 还没到日子的计划
    const occurred = time(result.occurred_start);
    if (occurred !== undefined && occurred > options.now.getTime()) return 'lasting';
    const touched = lastTouchedDay(result), today = civilDayNumber(options.now);
    if (touched === undefined || today === undefined) return 'lasting';
    const days = today - touched;
    const scale = (result.source_fact_ids?.length ?? 1) >= 2 || isSummary(result) ? 2 : 1;
    if (days <= CLEAR_DAYS * scale) return 'clear';
    if (days <= VAGUE_DAYS * scale) return 'vague';
    const { window } = options;
    const asked = window && isSummary(result) && civilDayInWindow(touched, window);
    return asked || recognizes(result, options) ? 'recognized' : 'forgotten';
}

/**
 * 提示词里放的聊天原文（实现时的调整 12，用户 10-06 定）：最近 CLEAR_DAYS 天的；这之前到现在这段聊天中间没说过话（隔了很久再来）时，
 * 再放上一次那段聊天，接得上话。更早的原话不放，只靠记忆（会变淡），免得几十天前的原话还一字不差地摆在她眼前。
 * 没有时间的消息算最近的。返回放进去的和不放的条数。
 * limit：最多几条（ADR 0036 决策 3），线上不传；「最近几轮 + 要点」的实验（ADR 0043）传 Infinity，自己按轮切
 */
export function recentChat<T extends { time?: string }>(chat: readonly T[], now: Date, limit = RAW_MESSAGES): { chat: T[]; omitted: number } {
    const at = (m: T) => (m.time ? Date.parse(m.time) : Number.NaN);
    const cutoff = now.getTime() - CLEAR_DAYS * DAY_MS;
    const recent = (m: T) => !(at(m) < cutoff);
    const together = (i: number) => !(at(chat[i]!) - at(chat[i - 1]!) >= EPISODE_GAP_MS);
    // 最后这段聊天从哪开始
    let current = chat.length - 1;
    while (current > 0 && together(current)) current--;
    let start = chat.findIndex(recent);
    if (start < 0) start = chat.length;
    // 他这会儿在说话，这段之前最近的一条却超过 CLEAR_DAYS 天了：放上一次那段（主动找他时最后这段就是上一次的，不再往前）
    if (current > 0 && start >= current && recent(chat.at(-1)!) && !recent(chat[current - 1]!)) {
        start = current - 1;
        while (start > 0 && together(start)) start--;
    }
    start = Math.min(start, Math.max(current, 0));
    // 原始聊天只留最近 80 条：更早的事实由召回提供，不能让几百条模型旧回复变成越来越强的自我模仿语料。
    // 80 条足够覆盖一段长对话；提示词预算仍会在单条特别长时继续裁剪。
    start = Math.max(start, chat.length - limit);
    return { chat: chat.slice(start), omitted: start };
}
