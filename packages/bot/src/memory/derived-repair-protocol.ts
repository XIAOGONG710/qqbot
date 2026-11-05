import { calendarDate, stateTimestamp } from './state-schema.ts';
import { createHash } from 'node:crypto';

/** Durable repair metadata only. Never put model content, chat text or credentials here. */
export interface RepairOwner { qq: number; tier: string }
export interface RepairSourceDocument { documentId: string; episodeDigest: string; contentHash: string; count: number }
export interface RepairCandidate {
    bankId: string;
    owner: RepairOwner;
    generation: string;
    eventSetHash: string;
    sourceManifestHash: string;
    sourceManifest: readonly RepairSourceDocument[];
    progressHash: string;
    /** Hash of owned relationship name/query/tags, independent of paused trigger settings. */
    modelIdentityHash: string;
    expectedAutomatic: boolean;
    expectedCadence: number;
}
export interface RepairLease {
    bankId: string; repairId: string; generation: string; eventSetHash: string;
    sourceManifestHash: string; progressHash: string;
}
export const REPAIR_PHASES = ['baseline', 'pause-dispatched', 'paused', 'clear-dispatched', 'cleared', 'refresh-dispatched', 'refresh-pending', 'restore-dispatched', 'restored', 'verified', 'blocked'] as const;
export type RepairPhase = typeof REPAIR_PHASES[number];
export interface RepairCheckpointEvidence {
    initialWatermark?: string;
    inventoryHash?: string;
    modelIdentityHash?: string;
    safeConfigHash?: string;
    restoredConfigHash?: string;
    originalAutomatic?: boolean;
    originalCadence?: number;
    clearContentHash?: string;
    refreshOperationId?: string;
    refreshOutcome?: 'content_written' | 'content_unchanged';
    modelContentHash?: string;
    modelSeenAt?: string;
    modelRefreshedAt?: string;
    modelIsStale?: false;
    finalWatermark?: string;
    /** Fixed classification, never a provider exception/message. */
    blockedReason?: 'dispatch-uncertain' | 'provider-rejected' | 'evidence-mismatch' | 'operation-failed';
}
/** Confirms only that a known obsolete refresh has stopped; never clears contamination. */
export interface RefreshSettlementEvidence {
    observedGeneration: string;
    operationId: string;
    operationType: 'refresh_mental_model';
    modelId: 'relationship';
    status: 'completed';
    outcome: 'content_written' | 'content_unchanged';
    quiescentWatermark: string;
    operations: { pending: 0; processing: 0; failed: 0; cancelled: 0 };
    pendingConsolidation: 0;
    failedConsolidation: 0;
    modelIdentityHash: string;
    configurationHash: string;
}
export interface RepairJournal { lease: RepairLease; phase: RepairPhase; evidence: RepairCheckpointEvidence; settlement?: RefreshSettlementEvidence }
export interface FinalEvidence {
    sourceManifestHash: string;
    progressHash: string;
    eventSetHash: string;
    initialWatermark: string;
    finalWatermark: string;
    inventoryHash: string;
    modelIdentityHash: string;
    safeConfigHash: string;
    restoredConfigHash: string;
    originalAutomatic: boolean;
    originalCadence: number;
    clearContentHash: string;
    refreshOperationId: string;
    refreshOutcome: 'content_written' | 'content_unchanged';
    modelContentHash: string;
    modelSeenAt: string;
    modelRefreshedAt: string;
    modelIsStale: false;
}
export interface RepairReceipt { repairId: string; generation: string }

export const repairFingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function repairSourceManifestHash(documents: readonly RepairSourceDocument[]): string {
    return repairFingerprint([...documents].sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0).map(({ documentId, episodeDigest, contentHash, count }) => ({ documentId, episodeDigest, contentHash, count })));
}
export function repairModelIdentityHash(model: { name: string; source_query: string; tags: readonly string[] }): string {
    return repairFingerprint({ name: model.name, source_query: model.source_query, tags: [...model.tags].sort() });
}
/** Compare exact ISO instants without truncating provider microseconds to Date milliseconds. */
export function repairCompareTimestamps(left: string, right: string): number | undefined {
    const parts = (value: string) => {
        if (!stateTimestamp(value) || !calendarDate(value.slice(0, 10))) return undefined;
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
        if (!match) return undefined;
        const whole = Date.parse(`${match[1]}${match[3]}`);
        return Number.isFinite(whole) ? { whole, fraction: match[2] ?? '' } : undefined;
    };
    const a = parts(left), b = parts(right);
    if (!a || !b) return undefined;
    if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
    const length = Math.max(a.fraction.length, b.fraction.length), x = a.fraction.padEnd(length, '0'), y = b.fraction.padEnd(length, '0');
    return x === y ? 0 : x < y ? -1 : 1;
}

export const repairHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const repairUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is string => stateTimestamp(value) && calendarDate(value.slice(0, 10));
export function isRepairLease(value: unknown): value is RepairLease {
    return object(value) && typeof value.bankId === 'string' && value.bankId.length > 0 && repairUuid(value.repairId)
        && repairUuid(value.generation) && repairHash(value.eventSetHash) && repairHash(value.sourceManifestHash) && repairHash(value.progressHash);
}
export function isRepairCheckpointEvidence(value: unknown): value is RepairCheckpointEvidence {
    if (!object(value)) return false;
    const hashes = ['inventoryHash', 'modelIdentityHash', 'safeConfigHash', 'restoredConfigHash', 'clearContentHash', 'modelContentHash'];
    const times = ['initialWatermark', 'finalWatermark', 'modelSeenAt', 'modelRefreshedAt'];
    const keys = [...hashes, ...times, 'refreshOperationId', 'refreshOutcome', 'blockedReason', 'originalAutomatic', 'originalCadence', 'modelIsStale'];
    return Object.keys(value).every(key => keys.includes(key))
        && hashes.every(key => value[key] === undefined || repairHash(value[key]))
        && times.every(key => value[key] === undefined || timestamp(value[key]))
        && (value.refreshOperationId === undefined || repairUuid(value.refreshOperationId))
        && (value.originalAutomatic === undefined || typeof value.originalAutomatic === 'boolean')
        && (value.modelIsStale === undefined || value.modelIsStale === false)
        && (value.originalCadence === undefined || Number.isSafeInteger(value.originalCadence) && (value.originalCadence as number) >= 0)
        && (value.refreshOutcome === undefined || value.refreshOutcome === 'content_written' || value.refreshOutcome === 'content_unchanged')
        && (value.blockedReason === undefined || value.blockedReason === 'dispatch-uncertain' || value.blockedReason === 'provider-rejected' || value.blockedReason === 'evidence-mismatch' || value.blockedReason === 'operation-failed');
}
export function isRepairJournal(value: unknown): value is RepairJournal {
    return object(value) && isRepairLease(value.lease) && REPAIR_PHASES.includes(value.phase as RepairPhase) && isRepairCheckpointEvidence(value.evidence)
        && (value.settlement === undefined || isRefreshSettlementEvidence(value.settlement)
            && value.settlement.observedGeneration !== value.lease.generation && value.settlement.operationId === value.evidence.refreshOperationId
            && value.settlement.modelIdentityHash === value.evidence.modelIdentityHash && value.settlement.configurationHash === value.evidence.safeConfigHash
            && (value.phase === 'refresh-pending' || value.phase === 'blocked'));
}
export function isRefreshSettlementEvidence(value: unknown): value is RefreshSettlementEvidence {
    const keys = ['observedGeneration', 'operationId', 'operationType', 'modelId', 'status', 'outcome', 'quiescentWatermark', 'operations',
        'pendingConsolidation', 'failedConsolidation', 'modelIdentityHash', 'configurationHash'];
    return object(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
        && repairUuid(value.observedGeneration) && repairUuid(value.operationId) && value.operationType === 'refresh_mental_model'
        && value.modelId === 'relationship' && value.status === 'completed' && (value.outcome === 'content_written' || value.outcome === 'content_unchanged')
        && timestamp(value.quiescentWatermark) && repairHash(value.modelIdentityHash) && repairHash(value.configurationHash)
        && value.pendingConsolidation === 0 && value.failedConsolidation === 0 && object(value.operations)
        && Object.keys(value.operations).length === 4 && ['pending', 'processing', 'failed', 'cancelled'].every(key =>
            Object.hasOwn(value.operations as object, key) && (value.operations as Record<string, unknown>)[key] === 0);
}
export function isFinalEvidence(value: unknown): value is FinalEvidence {
    if (!object(value)) return false;
    const { sourceManifestHash, progressHash, eventSetHash, ...checkpoint } = value;
    return repairHash(sourceManifestHash) && repairHash(progressHash) && repairHash(eventSetHash)
        && isRepairCheckpointEvidence(checkpoint) && checkpoint.blockedReason === undefined
        && ['initialWatermark', 'finalWatermark', 'inventoryHash', 'modelIdentityHash', 'safeConfigHash', 'restoredConfigHash', 'originalAutomatic', 'originalCadence', 'clearContentHash', 'refreshOperationId', 'refreshOutcome', 'modelContentHash', 'modelSeenAt', 'modelRefreshedAt', 'modelIsStale'].every(key => checkpoint[key as keyof RepairCheckpointEvidence] !== undefined);
}
