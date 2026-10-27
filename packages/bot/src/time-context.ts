// 运行时自己的时间提示（ADR 0004 决策 2，调研方案 5.3）：每次生成时算，放在聊天记录之后、末尾指令之前。
// - 当前日期、星期、时间（本机时区）
// - 距上一条消息多久：对方连发几条时按这一组的第一条算，不按最后一条（ST 的 idleDuration 按倒数第二条用户消息算，连发时只有几秒）。
//   她收尾后对方那几句附和已经按「不回」处理过，不算进这一组（reply-timing.ts 的 pendingMessages）
// - 对方的消息不是刚发的（例如 bot 停机期间发的，补回后才回复）时，说明是什么时候发的
// - 没有要回的消息（她主动找他，ADR 0011）：上一条消息是谁发的、多久前
// 重要的日子（ADR 0011 决策 6）另起一行（describeDays）：提前 7 天起提醒，当天「今天是……」，农历那天提一句。

import { dayMatches, lunarMonthDay, type ImportantDay } from './proactive.ts';
import { pendingMessages, unansweredMessages } from './social/reply-timing.ts';
import type { TimedMessage } from './st/time-macros.ts';

/** 回复一直失败（连不上模型）超过这么久才终于发出去，时间块里加一句断网的事实（ADR 0105） */
export const OFFLINE_NOTE_MS = 10 * 60_000;
/** 对方的消息发出超过这么久才回复时，提示是什么时候发的 */
export const LATE_REPLY_MS = 10 * 60_000;

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** initiating：她主动找他（ADR 0011），不是在回消息：只写上一条消息，不把没回的附和当成「这次的消息」 */
export function describeTime(chat: (TimedMessage & { content: string })[], now: Date, options: { initiating?: boolean; offlineSince?: number } = {}): string {
    const lines = [`[当前时间：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${WEEKDAYS[now.getDay()]} ${clock(now)}]`];

    // 这一组：她上次回复之后对方发的消息；只有附和、又要回（关掉作息时附和也回）就按附和算
    const first = options.initiating ? undefined : pendingMessages(chat)[0] ?? unansweredMessages(chat)[0];
    if (!first) {
        // 没有要回的（她主动找他）：上一条消息是谁发的、多久前
        const last = chat.at(-1);
        if (last?.time) {
            const time = new Date(last.time);
            lines.push(`[上一条消息：${when(time, now)}，${last.role === 'user' ? '对方' : '你'}发的，到现在 ${duration(now.getTime() - time.getTime())}]`);
        }
        return lines.join('\n');
    }
    const previous = chat[chat.indexOf(first) - 1];
    const firstTime = first.time ? new Date(first.time) : undefined;

    if (firstTime && previous?.time) {
        const previousTime = new Date(previous.time);
        lines.push(`[距上一条消息：${duration(firstTime.getTime() - previousTime.getTime())}（上一条在${when(previousTime, now)}）]`);
    }
    if (firstTime && now.getTime() - firstTime.getTime() > LATE_REPLY_MS) {
        lines.push(`[对方这次的消息是${when(firstTime, now)} 发的，到现在过了 ${duration(now.getTime() - firstTime.getTime())}]`);
    }
    // 断网很久才回（ADR 0105）：她这边连不上网是实情，可以顺口说一句“刚才网断了”；别编别的原因
    if (options.offlineSince !== undefined && now.getTime() - options.offlineSince >= OFFLINE_NOTE_MS) {
        lines.push(`[你这边有一阵子（约 ${duration(now.getTime() - options.offlineSince)}）一直连不上网，他的消息刚才才收到。他要是问你怎么才回，或者你顺口想解释，说一句“刚才网断了 / 没信号”就行；别编别的原因，也别道歉过头]`);
    }
    return lines.join('\n');
}

/** 日子提前这么多天开始提醒 */
export const DAYS_AHEAD = 7;

/** 重要的日子临近、当天的说明（一行一个日子）；这几天没有就返回 undefined */
export function describeDays(dates: readonly ImportantDay[], now: Date): string | undefined {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const lines: string[] = [];
    for (const important of dates) {
        if (dayMatches(important, today) === 'lunar') {
            const lunar = lunarName(important.lunar!);
            lines.push(important.date ? `[今天是农历${lunar}，按农历也是${important.name}]` : `[今天（农历${lunar}）是${important.name}]`);
            if (!important.date) continue;
        }
        for (let ahead = 0; ahead <= (important.ahead ?? DAYS_AHEAD); ahead++) {
            const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead);
            // 只写了农历的日子，提前几天也按农历算
            if (important.date ? dayMatches(important, day) !== 'solar' : lunarMonthDay(day) !== important.lunar) continue;
            const whenText = ahead === 0 ? '今天' : ahead === 1 ? '明天' : ahead === 2 ? '后天' : `再过 ${ahead} 天（${day.getMonth() + 1}月${day.getDate()}日）`;
            lines.push(`[${whenText}是${important.name}${important.hint ? `（${important.hint}）` : ''}]`);
            break;
        }
    }
    return lines.length ? lines.join('\n') : undefined;
}

const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 08-08 → 八月初八 */
export function lunarName(monthDay: string): string {
    const [month, day] = monthDay.split('-').map(Number) as [number, number];
    const dayText = day <= 10 ? `初${DIGITS[day]}` : day < 20 ? `十${DIGITS[day - 10]}` : day === 20 ? '二十' : day < 30 ? `廿${DIGITS[day - 20]}` : '三十';
    return `${LUNAR_MONTHS[month - 1]}月${dayText}`;
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
