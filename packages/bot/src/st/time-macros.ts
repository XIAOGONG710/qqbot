// SillyTavern 时间宏，对照 public/scripts/macros/definitions/time-macros.js。
// ST 用 moment 按界面语言格式化；这里固定按中文界面（moment 的 zh-cn 语言包），用运行时所在机器的本地时区。
// 实现了 {{time}} {{date}} {{weekday}} {{isotime}} {{isodate}} {{idleDuration}}（别名 {{idle_duration}}）；
// 带参数的 {{time::UTC+8}} {{datetimeformat::…}} {{timeDiff::…}} 没实现，原样保留。

export interface TimedMessage {
    role: 'user' | 'assistant';
    /** ISO 时间（聊天记录里的 time） */
    time?: string;
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const pad = (n: number) => String(n).padStart(2, '0');

export function timeMacros(now: Date, chat: TimedMessage[]): Record<string, string> {
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const idle = idleDuration(now, chat);
    return {
        time: hhmm, // moment().format('LT')，zh-cn 是 HH:mm
        date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`, // format('LL')
        weekday: WEEKDAYS[now.getDay()]!, // format('dddd')
        isotime: hhmm,
        isodate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
        idleduration: idle,
        idle_duration: idle,
    };
}

/**
 * getTimeSinceLastMessage：跳过最新一条消息，取再往前最近一条用户消息到现在的时长。
 * 找不到时 ST 返回英文的 'just now'（没有翻译），这里照抄。
 */
function idleDuration(now: Date, chat: TimedMessage[]): string {
    let takeNext = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i]!;
        if (message.role === 'user' && takeNext) {
            return message.time ? humanize(now.getTime() - Date.parse(message.time)) : 'just now';
        }
        takeNext = true;
    }
    return 'just now';
}

/** moment.duration(ms).humanize()，默认阈值，zh-cn 语言包的 relativeTime */
export function humanize(ms: number): string {
    const abs = Math.abs(ms);
    const seconds = Math.round(abs / 1000);
    const minutes = Math.round(abs / 60_000);
    const hours = Math.round(abs / 3_600_000);
    const daysExact = abs / 86_400_000;
    const days = Math.round(daysExact);
    const months = Math.round(daysExact * 4800 / 146097);
    const years = Math.round(daysExact * 4800 / 146097 / 12);

    if (seconds <= 44) return '几秒';
    if (seconds < 45) return `${seconds} 秒`;
    if (minutes <= 1) return '1 分钟';
    if (minutes < 45) return `${minutes} 分钟`;
    if (hours <= 1) return '1 小时';
    if (hours < 22) return `${hours} 小时`;
    if (days <= 1) return '1 天';
    if (days < 26) return `${days} 天`;
    if (months <= 1) return '1 个月';
    if (months < 11) return `${months} 个月`;
    if (years <= 1) return '1 年';
    return `${years} 年`;
}
