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

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 写入 Hindsight 的原文（ADR 0012 决策 1 第 3 条）：官方推荐的「名字 (时间): 内容」，时间只写 HH:MM，开头和换天时插一行日期；
 * 消息里的换行换成「／」，每行都有说话人。不写 QQ 消息 id（片段 id 就能追溯），一块（默认 3000 字符）能装下的消息多一倍。
 */
export function episodeTranscript(episode: Episode, names: MacroNames): string {
    const lines: string[] = [];
    let day = '';
    for (const m of episode.messages) {
        const time = new Date(m.time);
        const date = `—— ${time.getFullYear()}年${time.getMonth() + 1}月${time.getDate()}日 ${WEEKDAYS[time.getDay()]} ——`;
        if (date !== day) {
            lines.push(date);
            day = date;
        }
        const speaker = m.role === 'user' ? names.user : names.char;
        lines.push(`${speaker} (${pad2(time.getHours())}:${pad2(time.getMinutes())}): ${m.content.trim().replace(/\s*\n\s*/g, '／')}`);
    }
    return lines.join('\n');
}

/** 2026-10-01T20:00:00+08:00：本机时区 */
export function localIso(date: Date): string {
    const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
        + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}
