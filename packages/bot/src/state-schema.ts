/** 共享的保守状态校验：不把 null / 数组当成对象，不接受自动滚动的无效日期。 */
export const stateObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function calendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const at = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

export function stateTimestamp(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        && calendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
