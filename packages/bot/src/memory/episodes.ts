// 把聊天记录切成片段（ADR 0004 决策 3，调研方案 2.1、5.2）：相邻两条消息隔了 EPISODE_GAP_MS 以上，就是新的一段。
// 片段是写入 Hindsight 的单位：一个片段一个 document_id，片段变长或改了就整段替换（调研方案 9.7）。

import type { StoredMessage } from '../history.ts';
import type { MacroNames } from '../st/macros.ts';

/** 安静这么久算一段对话结束（调研方案 5.2 的起点） */
export const EPISODE_GAP_MS = 45 * 60_000;

export interface Episode {
    /** ep-<第一条消息的毫秒时间戳>，聊天记录不变就不变 */
    id: string;
    messages: StoredMessage[];
    start: Date;
    end: Date;
}

export function splitEpisodes(history: StoredMessage[]): Episode[] {
    const episodes: Episode[] = [];
    for (const message of history) {
        const time = new Date(message.time);
        const current = episodes.at(-1);
        if (current && time.getTime() - current.end.getTime() < EPISODE_GAP_MS) {
            current.messages.push(message);
            if (time > current.end) current.end = time;
        } else {
            episodes.push({ id: `ep-${time.getTime()}`, messages: [message], start: time, end: time });
        }
    }
    return episodes;
}

/** 写入 Hindsight 的原文：说话人、QQ 消息 id、带时区的时间（调研方案 9.5 的写法） */
export function episodeTranscript(episode: Episode, names: MacroNames): string {
    return episode.messages.map(m => {
        const speaker = m.role === 'user' ? names.user : names.char;
        const id = m.messageId === undefined ? '' : ` [message_id=${m.messageId}]`;
        return `${speaker}${id} (${localIso(new Date(m.time))}): ${m.content}`;
    }).join('\n');
}

/** 2026-10-01T20:00:00+08:00：本机时区 */
export function localIso(date: Date): string {
    const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}
