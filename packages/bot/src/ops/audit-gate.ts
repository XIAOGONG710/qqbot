// 依赖审计门（ADR 0070 第 11 项）：不盲目 `npm audit fix`，也不让历史基线让每次提交永远失败。
// 规则：出现 high / critical 一律不过；出现基线里没有的公告编号也不过（新增的要有人看过再放进基线）。

export interface AuditVia { source?: number; name?: string; severity?: string; title?: string; url?: string }
export interface AuditReport { vulnerabilities?: Record<string, { severity?: string; via?: (string | AuditVia)[] }> }
export interface AuditBaseline { advisories: number[]; note?: string }
export interface Advisory { id: number; name: string; severity: string; title: string; url: string }

/** 报告里每个不同的公告（npm 把同一个公告沿依赖链重复报很多次，按编号去重） */
export function advisoriesOf(report: AuditReport): Advisory[] {
    const found = new Map<number, Advisory>();
    for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
        for (const via of vulnerability.via ?? []) {
            if (typeof via !== 'object' || typeof via.source !== 'number') continue;
            found.set(via.source, {
                id: via.source, name: via.name ?? '?', severity: via.severity ?? vulnerability.severity ?? 'unknown',
                title: via.title ?? '', url: via.url ?? '',
            });
        }
    }
    return [...found.values()].sort((a, b) => a.id - b.id);
}

export interface AuditVerdict { ok: boolean; blocking: Advisory[]; fresh: Advisory[]; known: Advisory[]; gone: number[] }

export function judgeAudit(report: AuditReport, baseline: AuditBaseline): AuditVerdict {
    const all = advisoriesOf(report);
    const known = all.filter(item => baseline.advisories.includes(item.id));
    const fresh = all.filter(item => !baseline.advisories.includes(item.id));
    const blocking = all.filter(item => item.severity === 'high' || item.severity === 'critical');
    const gone = baseline.advisories.filter(id => !all.some(item => item.id === id));
    return { ok: blocking.length === 0 && fresh.length === 0, blocking, fresh, known, gone };
}
