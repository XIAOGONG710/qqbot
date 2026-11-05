import { calendarDate } from './state-schema.ts';

const DAY_MS = 86_400_000;

/** Provider compatibility follows Date.parse, while impossible ISO calendar dates never roll forward. */
export function providerTime(value: string | null | undefined): number | undefined {
    const prefix = typeof value === 'string' ? /^\s*(\d{4}-\d{2}-\d{2})/.exec(value) : undefined;
    if (prefix && !calendarDate(prefix[1]!)) return undefined;
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? time : undefined;
}

/** Civil day ordinal, independent of DST or a timezone skipping a whole calendar day. */
export function civilDayNumber(value: Date | string): number | undefined {
    if (typeof value === 'string') return calendarDate(value) ? Date.parse(`${value}T00:00:00Z`) / DAY_MS : undefined;
    if (!Number.isFinite(value.getTime())) return undefined;
    const civil = new Date(0);
    civil.setUTCFullYear(value.getFullYear(), value.getMonth(), value.getDate());
    return civil.getTime() / DAY_MS;
}

/** Same day-membership rule as local midnight >= start-of-start-day and < exact end. */
export function civilDayInWindow(day: number, window: { start: Date; end: Date }): boolean {
    const start = civilDayNumber(window.start), end = civilDayNumber(window.end);
    if (!Number.isSafeInteger(day) || start === undefined || end === undefined) return false;
    const endHasTime = window.end.getHours() !== 0 || window.end.getMinutes() !== 0 || window.end.getSeconds() !== 0 || window.end.getMilliseconds() !== 0;
    return day >= start && (day < end || day === end && endHasTime);
}
