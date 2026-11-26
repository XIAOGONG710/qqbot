// 「她现在在干嘛」只写一份（「同一个她」任务书 §2）：QQ 这边把状态渲染成 NOW.md，
// DSH 桌面只读它；超过 STALE_MS 没更新就当过期、不注入（QQ 没在跑的时候别拿旧状态冒充现在）。
// 为什么要反过来：以前 her-life.mjs 自己按另一套规则推进活动 / 心情，和 QQ 的作息 + 世界 + 心境对不上，
// 她会前后矛盾（审查 #9）。
import { renameSync, writeFileSync } from 'node:fs';
import type { Activity } from './schedule.ts';

/** 他最后一句在这个时间窗内，就说「和你聊天中」（Xavier 的中断层，2026-10-30） */
export const CHATTING_WINDOW_MS = 10 * 60_000;

/** 超过这么久没重写就算过期 */
export const NOW_STALE_MS = 30 * 60_000;
/** QQ 这边多久重写一次 */
export const NOW_REFRESH_MS = 10 * 60_000;

export interface NowText {
    /** 这一刻她在干什么（describeState 的原话） */
    doing: string;
    /** 心情 / 关系那一行事（可选，和 QQ 提示词里的关系行同源） */
    feeling?: string;
    /** 最近发生的一两件事（可选） */
    recent?: string[];
    /** 按作息她这会儿在睡（被他叫醒、正和他聊着不算）。给常驻进程判断醒不醒（ADR 0347 第 1 层），不进任何提示词 */
    asleep?: boolean;
    /** 一本日记（ADR 0347 第 3 层，oneDiary）：当天日记由 QQ 写，常驻进程的睡眠整合别再 journal_write。不给就没有这一行 */
    diaryBy?: 'qq';
    at: number;
}

/** NOW.md 里告诉常驻进程「当天日记 QQ 写了」的那一行（life/one-diary.ts 的契约；常驻进程按整行认） */
export const DIARY_BY_LINE = '<!-- diary-by: qq -->';

/** 渲染成文件内容：第一行是给机器看的生成时间，正文是给人读的几行 */
export function renderNow(text: NowText): string {
    const at = new Date(text.at).toISOString();
    const lines = [
        '<!-- 生成的，别手改：QQ 这边每 10 分钟重写一次；来源是作息 + 世界 + 心境 -->',
        `<!-- generated-at: ${at} -->`,
        ...(text.asleep === undefined ? [] : [`<!-- asleep: ${text.asleep ? 'yes' : 'no'} -->`]),
        ...(text.diaryBy === 'qq' ? [DIARY_BY_LINE] : []),
        '',
        text.doing,
        ...(text.feeling ? [text.feeling] : []),
        ...(text.recent?.length ? [`最近：${text.recent.join('；')}`] : []),
        '',
    ];
    return lines.join('\n');
}

/** 原子写，免得 DSH 读到半截 */
export function writeNow(path: string, content: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
}

/** 读生成时间；没有或坏了返回 undefined（等于过期） */
export function nowGeneratedAt(content: string): number | undefined {
    const match = /generated-at:\s*(\S+?)\s*-->/.exec(content);
    if (!match) return undefined;
    const at = Date.parse(match[1]!);
    return Number.isFinite(at) ? at : undefined;
}

/** 这份 NOW.md 还能不能用 */
export function nowFresh(content: string, now: number, staleMs = NOW_STALE_MS): boolean {
    const at = nowGeneratedAt(content);
    if (at === undefined) return false;
    return now - at <= staleMs;
}

/** 和你聊天中的时候，她作息上本来在干嘛（ADR 0347 第 3 层 desktopDay）：只说上课和睡觉这两种，别的不带 */
const WAS_TEXT: Partial<Record<Activity['kind'], string>> = { class: '本来在上课', sleep: '本来该睡了' };

/** 中断层的可选项（ADR 0347 第 3 层 desktopDay，方案 §2.2-1）；不给就和原来逐字一样 */
export interface ChatContext {
    /** 桌面上最后一轮的时刻：和 lastMessageAt（QQ 最后一句）取较晚的那个 */
    desktopAt?: number;
    /** 桌面在场（租约优先，desktop-presence.ts 的 presenceAt）：在就算聊着，不看时间窗 */
    desktopWith?: boolean;
    /** 作息上本来在干嘛：class / sleep 时写成「和你聊天中（本来在上课 / 本来该睡了）」 */
    was?: Activity['kind'];
}

/** 两个时刻里较晚的那个；都没有就是 undefined（不是有限数的当没有） */
export function laterOf(a: number | undefined, b: number | undefined): number | undefined {
    const ok = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
    if (!ok(a)) return ok(b) ? b : undefined;
    return ok(b) && b > a ? b : a;
}

/**
 * 中断层：他刚说过话的时候，别让她一边回消息一边「在看剧」。
 * 聊天期间的活动改成「和你聊天中」，聊完（超过窗口）自然回到原来的轨迹——不需要任何状态复原代码，
 * 因为下一次渲染会重新按作息算。
 * 给了 context（desktopDay）：桌面最后一轮也算「刚说过话」（和 QQ 最后一句取较晚的），桌面在场也算聊着；
 * 作息上本来在上课 / 睡觉就带上括号里那句。不给 context 和原来逐字一样。
 */
export function activityWithChat(doing: string, lastMessageAt: number | undefined, now: number, windowMs = CHATTING_WINDOW_MS, context?: ChatContext): string {
    const last = context ? laterOf(lastMessageAt, context.desktopAt) : lastMessageAt;
    const recent = last !== undefined && Number.isFinite(last) && now - last <= windowMs && now >= last;
    if (!recent && !context?.desktopWith) return doing;
    const was = context?.was === undefined ? undefined : WAS_TEXT[context.was];
    return was ? `和你聊天中（${was}）` : `和你聊天中`;
}

export interface NowDoingInput {
    /** describeState 的原话（按作息 + 世界） */
    base: string;
    /** 作息上这一刻在干嘛 */
    kind: Activity['kind'];
    /** QQ 上最后一句 */
    qqLastAt?: number;
    /** 未提供 desktopWith 时可用的桌面活动时间 */
    desktopLastAt?: number;
    /** 桌面在场（presenceAt(...).with，租约优先、回合兜底） */
    desktopWith?: boolean;
    now: number;
}

/**
 * NOW.md 的「在干嘛」和 asleep 行，desktopDay 开着时 App 用这个（关着时照旧调三个参数的 activityWithChat）。
 * - doing：QQ 仍用聊天时间窗；桌面用在场判定。作息是上课 / 睡觉时附带提示。
 * - asleep：照旧按作息写，只有 QQ 上聊着才算醒着；**桌面上聊着不改成 no**——她是被叫起来的，不是醒了（方案 §2.2-1）。
 */
export function nowDoing(input: NowDoingInput): { doing: string; asleep: boolean } {
    const { base, kind, now } = input;
    const doing = activityWithChat(base, input.qqLastAt, now, CHATTING_WINDOW_MS, {
        ...(input.desktopWith === undefined && input.desktopLastAt !== undefined ? { desktopAt: input.desktopLastAt } : {}),
        ...(input.desktopWith ? { desktopWith: true } : {}),
        was: kind,
    });
    const qqChatting = activityWithChat(base, input.qqLastAt, now) !== base;
    return { doing, asleep: kind === 'sleep' && !qqChatting };
}
