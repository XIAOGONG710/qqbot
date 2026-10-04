// 运行时自己的时间提示（ADR 0004 决策 2，调研方案 5.3）：每次生成时算，放在聊天记录之后、末尾指令之前。
// - 当前日期、星期、时间（本机时区）
// - 距上一条消息多久：对方连发几条时按这一组的第一条算，不按最后一条（ST 的 idleDuration 按倒数第二条用户消息算，连发时只有几秒）。
//   她收尾后对方那几句附和已经按「不回」处理过，不算进这一组（reply-timing.ts 的 pendingMessages）
// - 对方的消息不是刚发的（例如 bot 停机期间发的，补回后才回复）时，说明是什么时候发的

import { pendingMessages, unansweredMessages } from './reply-timing.ts';
import type { TimedMessage } from './st/time-macros.ts';

/** 对方的消息发出超过这么久才回复时，提示是什么时候发的 */
export const LATE_REPLY_MS = 10 * 60_000;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad = (n: number) => String(n).padStart(2, '0');

export function describeTime(chat: (TimedMessage & { content: string })[], now: Date): string {
    const lines = [`[当前时间：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${WEEKDAYS[now.getDay()]} ${clock(now)}]`];

    // 这一组：她上次回复之后对方发的消息；只有附和、又要回（关掉作息时附和也回）就按附和算
    const first = pendingMessages(chat)[0] ?? unansweredMessages(chat)[0];
    if (!first) return lines.join('\n');
    const previous = chat[chat.indexOf(first) - 1];
    const firstTime = first.time ? new Date(first.time) : undefined;

    if (firstTime && previous?.time) {
        const previousTime = new Date(previous.time);
        lines.push(`[距上一条消息：${duration(firstTime.getTime() - previousTime.getTime())}（上一条在${when(previousTime, now)}）]`);
    }
    if (firstTime && now.getTime() - firstTime.getTime() > LATE_REPLY_MS) {
        lines.push(`[对方这次的消息是${when(firstTime, now)} 发的，到现在过了 ${duration(now.getTime() - firstTime.getTime())}]`);
    }
    return lines.join('\n');
}

function clock(date: Date): string {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 今天 21:05 / 昨天 21:05 / 10月1日 21:05 / 2025年10月1日 21:05 */
export function when(date: Date, now: Date): string {
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(now) - day(date)) / 86_400_000);
    if (days === 0) return `今天 ${clock(date)}`;
    if (days === 1) return `昨天 ${clock(date)}`;
    if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${clock(date)}`;
}

/** 不到 1 分钟 / 25 分钟 / 3 小时 10 分钟 / 1 天 5 小时 / 4 天 */
export function duration(ms: number): string {
    const minutes = Math.floor(Math.max(0, ms) / 60_000);
    if (minutes < 1) return '不到 1 分钟';
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
    const days = Math.floor(hours / 24);
    return days < 3 && hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}
