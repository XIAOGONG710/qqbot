// 成人网站访问只使用用户填入的 HTTPS 页面，选址不由模型或搜索服务决定。
export const ADULT_SITE_SATISFACTION_THRESHOLD = 45;
const ATTEMPT_INTERVAL_MS = 24 * 60 * 60_000;

export function adultSiteUrls(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 10) throw new Error('adultSiteUrls 应为最多 10 个 HTTPS 网页地址的数组');
    const urls = value.map(item => {
        const url = typeof item === 'string' ? URL.parse(item) : null;
        if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) {
            throw new Error('adultSiteUrls 只接受 HTTPS 网页地址，不带端口、账号、查询参数或片段');
        }
        return url.href;
    });
    return [...new Set(urls)];
}

export function adultSiteVisitDue(satisfaction: number | undefined, lastAttemptAt: string | undefined, now: number): boolean {
    if (satisfaction === undefined || !Number.isFinite(satisfaction) || satisfaction >= ADULT_SITE_SATISFACTION_THRESHOLD) return false;
    return lastAttemptAt === undefined || now - Date.parse(lastAttemptAt) >= ATTEMPT_INTERVAL_MS;
}
