const MAX_EXTERNAL_ERROR = 160;

/** 供应商异常只保留短诊断摘要；日志和状态接口都不能带出凭据、令牌或 Cookie。 */
export function sanitizeExternalError(reason: unknown): string {
    const raw = reason instanceof Error ? reason.message : String(reason);
    const safe = raw
        .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
        .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,，;；]+/gi, '$1=<redacted>')
        .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1=<redacted>')
        .replace(/\b(session(?:id)?|refresh[_-]?token)\s*[:=]\s*[^\s,，;；]+/gi, '$1=<redacted>')
        .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?<redacted>')
        .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|密码)\s*[:：=]\s*[^\s,，;；&#]+/gi, '$1=<redacted>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_EXTERNAL_ERROR);
    return safe || '未知错误';
}
