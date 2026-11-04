/** 本地日历构造；保留数字 Date 构造器的溢出/DST 语义，但不把 0–99 年加上 1900。 */
export function localDate(year: number, monthIndex: number, ...parts: [day?: number, hour?: number, minute?: number, second?: number, millisecond?: number]): Date {
    // 其他年份直接沿用原生行为，包含夏令时和整日跳过（例如 Apia 2011-12-30）。
    if (!Number.isFinite(year) || Math.trunc(year) < 0 || Math.trunc(year) > 99) return new Date(year, monthIndex, ...parts);
    // 先在中立日历里归一化溢出的日/时钟，再只进行一次本地时区解析。
    const civil = new Date(0);
    civil.setUTCFullYear(year, monthIndex, parts.length >= 1 ? Number(parts[0]) : 1);
    civil.setUTCHours(parts.length >= 2 ? Number(parts[1]) : 0, parts.length >= 3 ? Number(parts[2]) : 0,
        parts.length >= 4 ? Number(parts[3]) : 0, parts.length >= 5 ? Number(parts[4]) : 0);
    const result = new Date(0);
    result.setFullYear(civil.getUTCFullYear(), civil.getUTCMonth(), civil.getUTCDate());
    result.setHours(civil.getUTCHours(), civil.getUTCMinutes(), civil.getUTCSeconds(), civil.getUTCMilliseconds());
    return result;
}
