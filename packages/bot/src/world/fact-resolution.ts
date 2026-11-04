export interface SourcedFact<T> {
    key: string;
    value: T;
    source: string;
    observedAt: string;
    validUntil: string;
    /** 越大越可信；同优先级、同一时间窗口内互相矛盾时不猜。 */
    priority: number;
}

export type FactResolution<T> =
    | { status: 'fresh'; value: T; source: string; observedAt: string; validUntil: string; candidates: number }
    | { status: 'conflict'; sources: string[]; candidates: number }
    | { status: 'stale' | 'unavailable'; candidates: number };

const time = (value: string) => Date.parse(value);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * 统一裁决现实世界事实：先丢弃畸形/未来/过期数据，再按可信级和观测时间选择。
 * 同等级的新鲜来源在冲突窗口内互相矛盾时返回 conflict，调用方必须隐藏该事实或人工核对。
 */
export function resolveWorldFact<T>(key: string, candidates: readonly SourcedFact<T>[], options: {
    now?: number;
    conflictWindowMs?: number;
    futureToleranceMs?: number;
} = {}): FactResolution<T> {
    const now = options.now ?? Date.now();
    const futureTolerance = options.futureToleranceMs ?? 60_000;
    const conflictWindow = options.conflictWindowMs ?? 15 * 60_000;
    const matching = candidates.filter(item => item.key === key);
    const valid = matching.filter(item => item.source.trim() && Number.isFinite(item.priority)
        && Number.isFinite(time(item.observedAt)) && Number.isFinite(time(item.validUntil))
        && time(item.observedAt) <= now + futureTolerance && time(item.validUntil) >= time(item.observedAt));
    const fresh = valid.filter(item => time(item.validUntil) >= now)
        .sort((left, right) => right.priority - left.priority || time(right.observedAt) - time(left.observedAt) || left.source.localeCompare(right.source));
    if (!fresh.length) return { status: valid.length ? 'stale' : 'unavailable', candidates: matching.length };
    const best = fresh[0]!;
    const peer = fresh.find(item => item !== best && item.priority === best.priority
        && Math.abs(time(item.observedAt) - time(best.observedAt)) <= conflictWindow
        && !same(item.value, best.value));
    if (peer) {
        return { status: 'conflict', sources: [...new Set([best.source, peer.source])].sort(), candidates: fresh.length };
    }
    return { status: 'fresh', value: best.value, source: best.source, observedAt: best.observedAt, validUntil: best.validUntil, candidates: fresh.length };
}
