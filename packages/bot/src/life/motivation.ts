// 影子动机与活动候选（ADR 0338）。
// Drive 是倾向，不是命令；ActivityCandidate 是可审计的候选，不是执行器调用。

import type { RegulationSnapshot } from './regulation.ts';

export const DRIVE_SOURCES = ['external', 'internal'] as const;
export type DriveSource = (typeof DRIVE_SOURCES)[number];
export const DRIVE_STATUSES = ['active', 'waiting', 'fulfilled', 'suppressed', 'expired'] as const;
export type DriveStatus = (typeof DRIVE_STATUSES)[number];
export const SHADOW_ACTIVITY_KINDS = ['remember', 'wait', 'observe', 'suppress'] as const;
export type ShadowActivityKind = (typeof SHADOW_ACTIVITY_KINDS)[number];

/** 一条来源明确的行动倾向；goal 只能是短标签，不能存用户原话。 */
export interface Drive {
    id: string;
    source: DriveSource;
    goal: string;
    target?: string;
    /** 外驱必须可追溯到事件或影响；内驱必须标出产生它的内部状态。 */
    eventIds?: readonly string[];
    impactIds?: readonly string[];
    stateKeys?: readonly string[];
    strength: number;
    urgency: number;
    persistence: number;
    createdAt: string;
    expiresAt?: string;
    status: DriveStatus;
}

export interface ShadowActivityCandidate {
    id: string;
    driveId: string;
    kind: ShadowActivityKind;
    createdAt: string;
    /** 为什么尚不外发，供审计和模拟器解释。 */
    reason: string;
}

const sources = new Set<string>(DRIVE_SOURCES);
const statuses = new Set<string>(DRIVE_STATUSES);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const ids = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every(nonEmpty);

export function validDrive(value: unknown): value is Drive {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const drive = value as Partial<Drive>;
    if (!nonEmpty(drive.id) || !sources.has(drive.source as string) || !nonEmpty(drive.goal) || drive.goal.length > 160
        || !unit(drive.strength) || !unit(drive.urgency) || !unit(drive.persistence) || !timestamp(drive.createdAt)
        || !statuses.has(drive.status as string)) return false;
    if (drive.target !== undefined && !nonEmpty(drive.target)) return false;
    if (drive.expiresAt !== undefined && (!timestamp(drive.expiresAt) || Date.parse(drive.expiresAt) < Date.parse(drive.createdAt))) return false;
    const hasExternalOrigin = ids(drive.eventIds) || ids(drive.impactIds);
    const hasInternalOrigin = ids(drive.stateKeys);
    return drive.source === 'external' ? hasExternalOrigin : hasInternalOrigin;
}

export function validShadowActivityCandidate(value: unknown): value is ShadowActivityCandidate {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Partial<ShadowActivityCandidate>;
    return nonEmpty(candidate.id) && nonEmpty(candidate.driveId)
        && (SHADOW_ACTIVITY_KINDS as readonly string[]).includes(candidate.kind as string)
        && timestamp(candidate.createdAt) && nonEmpty(candidate.reason) && candidate.reason.length <= 160;
}

/**
 * 影子模式只允许低风险的内部活动。恢复需求高时优先等待；否则把动机保留为“记住”。
 * 这里没有 message / search / tool / voice 等候选，确保这层不能绕过她的开口权。
 */
export function shadowActivityFor(drive: Drive, regulation: RegulationSnapshot, at: Date): ShadowActivityCandidate | undefined {
    if (!validDrive(drive) || !Number.isFinite(at.getTime()) || drive.status !== 'active') return undefined;
    if (drive.expiresAt && Date.parse(drive.expiresAt) < at.getTime()) {
        return { id: `${drive.id}:expired`, driveId: drive.id, kind: 'suppress', createdAt: at.toISOString(), reason: '动机已过期，影子层不补做' };
    }
    if (regulation.recoveryNeed >= 0.7) {
        return { id: `${drive.id}:wait`, driveId: drive.id, kind: 'wait', createdAt: at.toISOString(), reason: '恢复需求高，先不把动机升级成表达' };
    }
    return { id: `${drive.id}:remember`, driveId: drive.id, kind: 'remember', createdAt: at.toISOString(), reason: '影子模式只保留动机，不替她外发' };
}

