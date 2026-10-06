// 记忆变淡、一提就想起（ADR 0018 决策 1）：召回之后、整理成一段之前，给每条算现在还记得多清楚。
// - 长期知道的不变淡：没有发生日期的（偏好、习惯、他是做什么的）、重要的（Hindsight 写入时在事实开头标了【重要】，
//   整合成观察后标记会丢，所以也看观察背后的事实）、还没到日子的计划。
// - 某天的事按「最后一次沾到它」到今天过了几天：发生的日子和最后一次被提起的日子取晚的（他又说起一次就算重新记了一遍）；
//   日记按那篇的日子。CLEAR_DAYS 以内清楚，VAGUE_DAYS 以内记个大概，再早的想不起来；提过 2 次以上（观察背后有 2 条以上事实）的期限翻倍。
// - 想不起来的，他这次的话（她上次回复之后的）里出现了这条的某个实体名（至少 2 个字，不算她和名单里的称呼）就想起来，细节按记个大概说。

import type { RecallResult } from './hindsight.ts';

/** 只提过一次的：几天以内清楚、几天以内记个大概 */
export const CLEAR_DAYS = 7;
export const VAGUE_DAYS = 30;
/** Hindsight 写入时给重要的事标的记号（写入说明里的规则，见 long-term.ts 的 missions） */
export const IMPORTANT = '【重要】';

/** lasting 长期知道的；clear 清楚；vague 记个大概；recognized 本来想不起来，他一提想起来了；forgotten 想不起来 */
export type Clarity = 'lasting' | 'clear' | 'vague' | 'recognized' | 'forgotten';

export interface FadeOptions {
    now: Date;
    /** 他这次说的话（她上次回复之后的） */
    heard: string;
    /** 不算「一提就想起」的名字：她的、名单里的称呼（提到鸽鸽不等于想起鸽鸽的每件旧事） */
    ignore: readonly string[];
}

/** 一次召回里记个大概、一提想起、想不起来各几条（日志用） */
export interface FadeStats {
    vague: number;
    recognized: number;
    forgotten: number;
}

const DAY_MS = 86_400_000;
const MIN_NAME_CHARS = 2;
/** 按那篇的日子算的文档：日记 */
const DATED_DOCUMENT = /^diary:(\d{4})-(\d{2})-(\d{2})$/;

const time = (iso: string | null | undefined): number | undefined => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? undefined : t;
};

/** 重要的：自己开头有【重要】，或者背后的事实有 */
export function isImportant(result: RecallResult): boolean {
    return [result.text, ...(result.sources ?? [])].some(text => text.trimStart().startsWith(IMPORTANT));
}

/** 去掉【重要】记号（放进提示词前） */
export function withoutMark(text: string): string {
    return text.replaceAll(IMPORTANT, '').trim();
}

/** 最后一次沾到它的时间：日记按那篇的日子；别的取发生、结束、最后一次被提起里最晚的。没有发生日期（长期知道的）返回 undefined */
export function lastTouched(result: RecallResult): Date | undefined {
    const document = DATED_DOCUMENT.exec(result.document_id ?? '');
    if (document) return new Date(Number(document[1]), Number(document[2]) - 1, Number(document[3]));
    const occurred = time(result.occurred_start);
    if (occurred === undefined) return undefined;
    return new Date(Math.max(occurred, time(result.occurred_end) ?? 0, time(result.mentioned_at) ?? 0));
}

/** 从 then 那天到 now 那天隔了几天（本地日历日） */
function daysBetween(then: Date, now: Date): number {
    const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.round((day(now) - day(then)) / DAY_MS);
}

/** 他这次的话里有没有这条的某个实体名 */
function recognizes(result: RecallResult, options: FadeOptions): boolean {
    return (result.entities ?? []).some(name => [...name].length >= MIN_NAME_CHARS && !options.ignore.includes(name) && options.heard.includes(name));
}

/** 这条现在还记得多清楚 */
export function clarity(result: RecallResult, options: FadeOptions): Clarity {
    if (isImportant(result)) return 'lasting';
    // 还没到日子的计划
    const occurred = time(result.occurred_start);
    if (occurred !== undefined && occurred > options.now.getTime()) return 'lasting';
    const touched = lastTouched(result);
    if (!touched) return 'lasting';
    const days = daysBetween(touched, options.now);
    const scale = (result.source_fact_ids?.length ?? 1) >= 2 ? 2 : 1;
    if (days <= CLEAR_DAYS * scale) return 'clear';
    if (days <= VAGUE_DAYS * scale) return 'vague';
    return recognizes(result, options) ? 'recognized' : 'forgotten';
}
