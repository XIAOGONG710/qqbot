// 「她现在在干嘛」只写一份（「同一个她」任务书 §2）：QQ 这边把状态渲染成 NOW.md，
// DSH 桌面只读它；超过 STALE_MS 没更新就当过期、不注入（QQ 没在跑的时候别拿旧状态冒充现在）。
// 为什么要反过来：以前 her-life.mjs 自己按另一套规则推进活动 / 心情，和 QQ 的作息 + 世界 + 心境对不上，
// 她会前后矛盾（审查 #9）。
import { renameSync, writeFileSync } from 'node:fs';

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
    at: number;
}

/** 渲染成文件内容：第一行是给机器看的生成时间，正文是给人读的几行 */
export function renderNow(text: NowText): string {
    const at = new Date(text.at).toISOString();
    const lines = [
        '<!-- 生成的，别手改：QQ 这边每 10 分钟重写一次；来源是作息 + 世界 + 心境 -->',
        `<!-- generated-at: ${at} -->`,
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

/**
 * 中断层：他刚说过话的时候，别让她一边回消息一边「在看剧」。
 * 聊天期间的活动改成「和你聊天中」，聊完（超过窗口）自然回到原来的轨迹——不需要任何状态复原代码，
 * 因为下一次渲染会重新按作息算。
 */
export function activityWithChat(doing: string, lastMessageAt: number | undefined, now: number, windowMs = CHATTING_WINDOW_MS): string {
    if (lastMessageAt === undefined || !Number.isFinite(lastMessageAt)) return doing;
    if (now - lastMessageAt > windowMs || now < lastMessageAt) return doing;
    return `和你聊天中`;
}
