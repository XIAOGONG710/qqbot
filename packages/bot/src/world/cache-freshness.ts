/** 允许很小的系统时钟误差；更远的未来时间戳视为损坏缓存。 */
export const CACHE_FUTURE_TOLERANCE_MS = 60_000;

/** 返回非负缓存年龄；时间无效或明显来自未来时返回 undefined。 */
export function cacheAgeMs(fetchedAt: string | number, now: number, futureToleranceMs = CACHE_FUTURE_TOLERANCE_MS): number | undefined {
    const parsed = typeof fetchedAt === 'number' ? fetchedAt : Date.parse(fetchedAt);
    if (!Number.isFinite(parsed)) return undefined;
    const age = now - parsed;
    if (age < -futureToleranceMs) return undefined;
    return Math.max(0, age);
}
