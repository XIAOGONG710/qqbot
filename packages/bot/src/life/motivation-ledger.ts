// 影子动机账：记录驱动与候选活动，供重放、模拟和人工审计使用。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { TransientStateError } from '../memory/transient-io.ts';
import { validDrive, validShadowActivityCandidate, type Drive, type ShadowActivityCandidate } from './motivation.ts';

interface MotivationFile { version: 1; drives: Drive[]; candidates: ShadowActivityCandidate[] }

export interface MotivationLedger {
    drives(): readonly Drive[];
    candidates(): readonly ShadowActivityCandidate[];
    appendDrives(drives: readonly Drive[]): number;
    appendCandidates(candidates: readonly ShadowActivityCandidate[]): number;
}

function unique<T extends { id: string }>(items: readonly T[]): boolean { return new Set(items.map(item => item.id)).size === items.length; }
function validFile(value: unknown): value is MotivationFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const file = value as Partial<MotivationFile>;
    return file.version === 1 && Array.isArray(file.drives) && Array.isArray(file.candidates)
        && file.drives.every(validDrive) && file.candidates.every(validShadowActivityCandidate)
        && unique(file.drives) && unique(file.candidates)
        && file.candidates.every(candidate => file.drives!.some(drive => drive.id === candidate.driveId));
}

function append<T extends { id: string }>(current: readonly T[], incoming: readonly T[], valid: (value: unknown) => value is T, label: string): T[] {
    const byId = new Map<string, T>();
    for (const item of [...current, ...incoming]) {
        if (!valid(item)) {
            const id = item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? 'unknown') : 'unknown';
            throw new Error(`${label}格式无效：${id}`);
        }
        if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return [...byId.values()];
}

export function readMotivationLedger(path: string, log: (message: string) => void = () => undefined): MotivationLedger {
    let loaded: MotivationFile | undefined;
    try {
        loaded = readJsonOr<MotivationFile | undefined>(path, undefined, log, {
            validate: (value): value is MotivationFile | undefined => value === undefined || validFile(value),
            invalid: 'throw', label: '影子动机账',
        });
    } catch (error) {
        if (error instanceof TransientStateError) throw error;
        throw new Error(`影子动机账 ${path} 读取或校验失败（JSON 或 schema 无效），拒绝启动；原文件未重建，请修复后重试`);
    }
    let drives = loaded?.drives ?? [];
    let candidates = loaded?.candidates ?? [];
    const commit = (nextDrives: Drive[], nextCandidates: ShadowActivityCandidate[]) => {
        writeJsonAtomic(path, { version: 1, drives: nextDrives, candidates: nextCandidates } satisfies MotivationFile);
        drives = nextDrives;
        candidates = nextCandidates;
    };
    return {
        drives: () => drives,
        candidates: () => candidates,
        appendDrives: incoming => {
            const next = append(drives, incoming, validDrive, '影子动机');
            const added = next.length - drives.length;
            if (added) commit(next, candidates);
            return added;
        },
        appendCandidates: incoming => {
            const next = append(candidates, incoming, validShadowActivityCandidate, '影子活动候选');
            if (!next.every(candidate => drives.some(drive => drive.id === candidate.driveId))) throw new Error('影子活动候选引用了不存在的动机');
            const added = next.length - candidates.length;
            if (added) commit(drives, next);
            return added;
        },
    };
}

