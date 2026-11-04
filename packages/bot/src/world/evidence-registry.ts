import { resolveWorldFact, type FactResolution, type SourcedFact } from './fact-resolution.ts';

export interface WorldEvidenceReport {
    keys: number;
    fresh: number;
    conflicts: number;
    stale: number;
    unavailable: number;
    sources: number;
    healthy: boolean;
}

/** 对同一事实键的多个现实来源做统一裁决；报告只含计数，不泄露地点和值。 */
export function resolveWorldEvidence(candidates: readonly SourcedFact<unknown>[], now = Date.now()): {
    facts: ReadonlyMap<string, FactResolution<unknown>>;
    report: WorldEvidenceReport;
} {
    const keys = [...new Set(candidates.map(item => item.key).filter(Boolean))].sort();
    const facts = new Map<string, FactResolution<unknown>>();
    for (const key of keys) facts.set(key, resolveWorldFact(key, candidates, { now }));
    const values = [...facts.values()];
    const count = (status: FactResolution<unknown>['status']) => values.filter(item => item.status === status).length;
    const report = {
        keys: keys.length,
        fresh: count('fresh'),
        conflicts: count('conflict'),
        stale: count('stale'),
        unavailable: count('unavailable'),
        sources: new Set(candidates.map(item => item.source).filter(Boolean)).size,
        healthy: values.length > 0 && values.every(item => item.status === 'fresh'),
    };
    return { facts, report };
}
