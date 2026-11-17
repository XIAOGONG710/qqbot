// 影子动机与活动候选（ADR 0338）。
// Drive 是倾向，不是命令；ActivityCandidate 是可审计的候选，不是执行器调用。

import type { RegulationSnapshot } from './regulation.ts';

export const DRIVE_SOURCES = ['external', 'internal'] as const;
export type DriveSource = (typeof DRIVE_SOURCES)[number];
export const DRIVE_STATUSES = ['active', 'waiting', 'fulfilled', 'suppressed', 'expired'] as const;
export type DriveStatus = (typeof DRIVE_STATUSES)[number];
export const SHADOW_ACTIVITY_KINDS = ['remember', 'wait', 'observe', 'self_care', 'adjust_schedule', 'research', 'message', 'ask_permission', 'suppress'] as const;
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
    /** 为什么选择或保留这个候选，供审计和模拟器解释。 */
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

const internalAt = (regulation: RegulationSnapshot): string | undefined => Number.isFinite(Date.parse(regulation.at)) ? regulation.at : undefined;
const internalWindow = (at: string): string => at.slice(0, 10);
const level = (value: number): 'high' | 'critical' => value >= 0.8 ? 'critical' : 'high';

/**
 * 把功能性调节快照转成内驱，而不是把一组数直接当作“情绪”或医学诊断。
 *
 * 只有明显的负荷才产生候选；有社交/认知余量不等于系统替她虚构“想聊天 / 想学习”。
 * 同一天、同一强度档位有稳定身份，轮询不会不断制造新的内驱记录。
 */
export function internalDrivesAt(regulation: RegulationSnapshot): Drive[] {
    const at = internalAt(regulation);
    if (!at) return [];
    const window = internalWindow(at);
    const drives: Drive[] = [];
    const add = (key: string, goal: string, strength: number, urgency: number) => {
        const bucket = level(strength);
        drives.push({
            id: `drive:internal:${key}:${window}:${bucket}`, source: 'internal', goal, target: 'self', stateKeys: [`regulation.${key}`],
            strength, urgency, persistence: 0.6, createdAt: at, status: 'active',
        });
    };
    if (regulation.recoveryNeed >= 0.55) add('recoveryNeed', '恢复精力，降低负荷', regulation.recoveryNeed, regulation.recoveryNeed >= 0.8 ? 0.8 : 0.45);
    if (regulation.discomfort >= 0.4) add('discomfort', '照顾身体不适', regulation.discomfort, regulation.discomfort >= 0.8 ? 0.85 : 0.5);
    if (regulation.arousal >= 0.7) add('arousal', '缓和紧绷，整理状态', regulation.arousal, regulation.arousal >= 0.85 ? 0.75 : 0.4);
    if (regulation.socialCapacity <= 0.35) add('socialCapacity', '保留社交容量', 1 - regulation.socialCapacity, 0.3);
    if (regulation.cognitiveCapacity <= 0.35) add('cognitiveCapacity', '减少认知负荷', 1 - regulation.cognitiveCapacity, 0.35);
    return drives;
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
    if (drive.source === 'internal' && drive.stateKeys?.some(key => /regulation\.(?:recoveryNeed|discomfort)/.test(key))) {
        return { id: `${drive.id}:self-care`, driveId: drive.id, kind: 'self_care', createdAt: at.toISOString(), reason: '身体和恢复需要优先；具体休息行动仍由生活裁判决定' };
    }
    if (regulation.recoveryNeed >= 0.7) {
        return { id: `${drive.id}:wait`, driveId: drive.id, kind: 'wait', createdAt: at.toISOString(), reason: '恢复需求高，先不把动机升级成表达' };
    }
    return { id: `${drive.id}:remember`, driveId: drive.id, kind: 'remember', createdAt: at.toISOString(), reason: '影子模式只保留动机，不替她外发' };
}

