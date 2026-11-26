// 影子动机裁决：多个倾向可以同时存在，但不必同时占据注意力。
// focus 仍只是内部关注，绝不表示发送消息或调用执行器。

import type { Drive, ShadowActivityCandidate } from './motivation.ts';
import { shadowActivityFor } from './motivation.ts';
import type { RegulationSnapshot } from './regulation.ts';

export const SHADOW_DECISION_OUTCOMES = ['focus', 'wait', 'suppress'] as const;
export type ShadowDecisionOutcome = (typeof SHADOW_DECISION_OUTCOMES)[number];

export interface ShadowDriveDecision {
    id: string;
    driveId: string;
    outcome: ShadowDecisionOutcome;
    score: number;
    decidedAt: string;
    reason: string;
}

const outcomes = new Set<string>(SHADOW_DECISION_OUTCOMES);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validShadowDriveDecision(value: unknown): value is ShadowDriveDecision {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const decision = value as Partial<ShadowDriveDecision>;
    return nonEmpty(decision.id) && nonEmpty(decision.driveId) && outcomes.has(decision.outcome as string)
        && unit(decision.score) && timestamp(decision.decidedAt) && nonEmpty(decision.reason) && decision.reason.length <= 160;
}

const round = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
const maintenance = (drive: Drive) => drive.stateKeys?.some(key => /recoveryNeed|discomfort|cognitiveCapacity/.test(key)) ?? false;
const commitment = (drive: Drive) => drive.eventIds?.some(id => id.startsWith('promise.')) ?? false;
const scoreOf = (drive: Drive) => round(drive.strength * 0.55 + drive.urgency * 0.35 + drive.persistence * 0.1);

/** 恢复优先、同类外部线索只聚焦一个、其余等待；这里只裁决注意力，不裁决表达。 */
export function resolveShadowDrives(drives: readonly Drive[], regulation: RegulationSnapshot, at: Date): ShadowDriveDecision[] {
    if (!Number.isFinite(at.getTime())) return [];
    const active = drives.filter(drive => drive.status === 'active');
    const ranked = active.map(drive => ({ drive, score: scoreOf(drive) })).sort((a, b) => b.score - a.score || a.drive.id.localeCompare(b.drive.id, 'zh-CN'));
    let maintenanceFocused = false;
    let contextualFocused = false;
    return ranked.map(({ drive, score }) => {
        let outcome: ShadowDecisionOutcome = 'focus';
        let reason = '当前可保留这一项内部关注';
        if (drive.expiresAt && Date.parse(drive.expiresAt) < at.getTime()) { outcome = 'suppress'; reason = '动机已过期，不补做'; }
        else if (score < 0.2) { outcome = 'wait'; reason = '动机强度不足，先保留观察'; }
        else if (regulation.recoveryNeed >= 0.7 && !maintenance(drive) && !commitment(drive)) { outcome = 'wait'; reason = '恢复需求高，暂不分配额外注意力'; }
        else if (maintenance(drive) && maintenanceFocused) { outcome = 'wait'; reason = '已有更优先的恢复类动机'; }
        else if (!maintenance(drive) && drive.source === 'external' && contextualFocused) { outcome = 'wait'; reason = '同类外部线索合并等待'; }
        if (outcome === 'focus' && maintenance(drive)) maintenanceFocused = true;
        if (outcome === 'focus' && !maintenance(drive) && drive.source === 'external') contextualFocused = true;
        return { id: `decision:${drive.id}`, driveId: drive.id, outcome, score, decidedAt: at.toISOString(), reason };
    });
}

/** 将裁决投影为允许的内部候选；没有任何分支能产出外部动作。 */
export function shadowActivityForDecision(decision: ShadowDriveDecision, drive: Drive, regulation: RegulationSnapshot, at: Date): ShadowActivityCandidate | undefined {
    if (!validShadowDriveDecision(decision) || decision.driveId !== drive.id) return undefined;
    if (decision.outcome === 'suppress') return { id: `${drive.id}:suppressed`, driveId: drive.id, kind: 'suppress', createdAt: at.toISOString(), reason: decision.reason };
    if (decision.outcome === 'wait') return { id: `${drive.id}:wait`, driveId: drive.id, kind: 'wait', createdAt: at.toISOString(), reason: decision.reason };
    return shadowActivityFor(drive, regulation, at);
}
