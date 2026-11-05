import { createHash } from 'node:crypto';
import { isSafeRepairModel, type DerivedRepairApi, type RepairModelEvidence, type RepairStats } from './hindsight.ts';
import {
    repairFingerprint, repairHash, repairModelIdentityHash, repairSourceManifestHash, repairUuid,
    type FinalEvidence, type RepairCandidate, type RepairCheckpointEvidence, type RepairJournal, type RepairLease, type RepairPhase, type RepairReceipt,
} from './derived-repair-protocol.ts';

type Model = RepairModelEvidence;
type Stats = RepairStats;
export type RepairApi = DerivedRepairApi;
export interface RepairStateStore {
    snapshot(bank: string): { generation: string; dirty: boolean; eventSetHash: string; documents: readonly string[]; owners: readonly { qq: number; tier: string; allDocuments: boolean }[]; unresolvedRepairIds: readonly string[]; repair?: RepairJournal };
    beginRepair(bank: string, input: { expectedGeneration: string; eventSetHash: string; sourceManifestHash: string; sourceManifest: RepairCandidate['sourceManifest']; owner: RepairCandidate['owner']; progressHash: string }): RepairLease;
    checkpoint(lease: RepairLease, phase: RepairPhase, evidence: RepairCheckpointEvidence): void;
    commitVerifiedRepair(lease: RepairLease, evidence: FinalEvidence): RepairReceipt;
}
export type RepairResult = 'repaired' | 'clean' | 'waiting' | 'blocked' | 'stale' | 'stopped' | 'unavailable';
export interface DerivedRepairOptions {
    api: RepairApi; store: RepairStateStore;
    /** Recompute from fresh reliable history/progress; never merely compare a captured object. */
    isCurrent?(candidate: RepairCandidate): boolean;
    log?: (message: string) => void;
}
const MODEL = 'relationship';
const EMPTY = createHash('sha256').update('').digest('hex');
const bodyHash = (text: string) => createHash('sha256').update(text).digest('hex');
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Finite, restartable private-bank repair. JSON checkpoints own every dispatched mutation. */
export class DerivedRepair {
    readonly #options: DerivedRepairOptions;
    readonly #flights = new Map<string, Promise<RepairResult>>();
    readonly #mutations = new Set<Promise<unknown>>();
    readonly #checks = new WeakMap<RepairCandidate, () => boolean>();
    readonly #cancelReads = new Set<() => void>();
    #stopped = false;
    #drain?: Promise<void>;
    constructor(options: DerivedRepairOptions) { this.#options = options; }

    stop(): Promise<void> | undefined {
        if (this.#stopped) return this.#drain;
        this.#stopped = true;
        for (const cancel of this.#cancelReads) cancel();
        this.#cancelReads.clear();
        if (this.#mutations.size) this.#drain = Promise.allSettled([...this.#mutations]).then(() => {});
        return this.#drain;
    }

    step(candidate: RepairCandidate, isCurrent: () => boolean): Promise<RepairResult> { return this.tick(candidate, isCurrent); }

    tick(candidate: RepairCandidate, isCurrent?: () => boolean): Promise<RepairResult> {
        if (this.#stopped) return Promise.resolve('stopped');
        const previous = this.#flights.get(candidate.bankId);
        if (previous) return previous;
        // Caller mutations cannot change the evidence owned by this invocation.
        candidate = structuredClone(candidate);
        if (isCurrent) this.#checks.set(candidate, isCurrent);
        const job = this.#run(candidate).catch(() => {
            if (this.#stopped) return 'stopped' as const;
            try { this.#options.log?.('派生记忆修复证据暂不可确认；保留屏障与派发记录，不重放未知请求'); } catch { /* Diagnostics do not change evidence. */ }
            return 'unavailable' as const;
        });
        this.#flights.set(candidate.bankId, job);
        const release = () => { if (this.#flights.get(candidate.bankId) === job) this.#flights.delete(candidate.bankId); };
        void job.then(release, release);
        return job;
    }

    #current(candidate: RepairCandidate): boolean {
        if (this.#stopped || !(this.#checks.get(candidate)?.() ?? this.#options.isCurrent?.(candidate) ?? false)) return false;
        const state = this.#options.store.snapshot(candidate.bankId);
        return state.dirty && state.generation === candidate.generation && state.eventSetHash === candidate.eventSetHash;
    }
    #checkpoint(lease: RepairLease, phase: RepairPhase, evidence: RepairCheckpointEvidence): void {
        this.#options.store.checkpoint(lease, phase, evidence);
    }

    #read<T>(work: () => Promise<T>): Promise<T> {
        if (this.#stopped) return Promise.reject(new Error('stopped'));
        return new Promise((resolve, reject) => {
            const cancel = () => { this.#cancelReads.delete(cancel); reject(new Error('stopped')); };
            this.#cancelReads.add(cancel);
            let job: Promise<T>;
            try { job = work(); } catch (error) { this.#cancelReads.delete(cancel); reject(error); return; }
            void job.then(value => { this.#cancelReads.delete(cancel); if (this.#stopped) reject(new Error('stopped')); else resolve(value); },
                error => { this.#cancelReads.delete(cancel); reject(error); });
        });
    }
    #blocked(lease: RepairLease, reason: RepairCheckpointEvidence['blockedReason']): RepairResult {
        this.#checkpoint(lease, 'blocked', { blockedReason: reason });
        return 'blocked';
    }

    async #mutation<T>(work: () => Promise<T>, acknowledged: (value: T) => void): Promise<T> {
        if (this.#stopped) throw new Error('stopped');
        // Register before an injected provider can synchronously call stop(). ACK checkpoint belongs to drain.
        let start!: () => void;
        const ready = new Promise<void>(done => { start = done; });
        const job = ready.then(() => { if (this.#stopped) throw new Error('stopped'); return work(); }).then(value => { acknowledged(value); return value; });
        this.#mutations.add(job); start();
        const release = () => { this.#mutations.delete(job); };
        void job.then(release, release);
        return job;
    }

    async #idle(candidate: RepairCandidate): Promise<Stats | undefined> {
        const stats = await this.#read(() => this.#options.api.repairStats(candidate.bankId));
        if (!this.#current(candidate)) return undefined;
        if (stats.pending_consolidation !== 0 || stats.failed_consolidation !== 0 || !validTime(stats.last_memory_write_at)) return undefined;
        const active = await this.#read(() => this.#options.api.repairActiveOperations(candidate.bankId));
        if (!this.#current(candidate) || active.length) return undefined;
        return stats;
    }
    async #inventory(candidate: RepairCandidate): Promise<string | undefined> {
        const documents = await this.#read(() => this.#options.api.repairDocuments(candidate.bankId));
        if (!this.#current(candidate)) return undefined;
        const models = await this.#read(() => this.#options.api.repairModels(candidate.bankId));
        if (!this.#current(candidate)) return undefined;
        const expected = new Map(candidate.sourceManifest.map(item => [item.documentId, item.contentHash]));
        if (documents.length !== expected.size || new Set(documents.map(item => item.id)).size !== documents.length
            || documents.some(item => item.bank_id !== candidate.bankId || expected.get(item.id) !== item.content_hash
                || !item.tags.includes('qq-private') || item.tags.some(tag => tag !== 'qq-private'))
            || models.length !== 1 || models[0]!.id !== MODEL || models[0]!.bank_id !== candidate.bankId || models[0]!.tags.length !== 1 || models[0]!.tags[0] !== 'qq-private') return undefined;
        return repairFingerprint({ documents: [...documents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(item => ({ id: item.id, content_hash: item.content_hash, tags: [...item.tags].sort() })), models: [{ id: MODEL, name: models[0]!.name, tags: ['qq-private'] }] });
    }
    #identity(candidate: RepairCandidate, model: Model): boolean {
        return model.id === MODEL && model.bank_id === candidate.bankId && repairModelIdentityHash(model) === candidate.modelIdentityHash;
    }
    #safe(candidate: RepairCandidate, model: Model, automatic = false): boolean {
        return this.#identity(candidate, model) && repairHash(model.configuration_hash)
            && isSafeRepairModel(model, automatic)
            && model.trigger.min_refresh_interval_seconds === candidate.expectedCadence;
    }

    async #run(candidate: RepairCandidate): Promise<RepairResult> {
        const { api, store } = this.#options;
        if (candidate.bankId.endsWith('-common') || !candidate.sourceManifest.length
            || repairSourceManifestHash(candidate.sourceManifest) !== candidate.sourceManifestHash
            || new Set(candidate.sourceManifest.map(item => item.documentId)).size !== candidate.sourceManifest.length
            || candidate.sourceManifest.some(item => !/^ep--?\d+$/.test(item.documentId) || !repairHash(item.episodeDigest) || !repairHash(item.contentHash) || !Number.isSafeInteger(item.count) || item.count < 1)
            || !Number.isSafeInteger(candidate.expectedCadence) || candidate.expectedCadence < 0 || typeof candidate.expectedAutomatic !== 'boolean') return 'blocked';
        const snapshot = store.snapshot(candidate.bankId);
        if (!snapshot.dirty) return 'clean';
        if (snapshot.owners.length !== 1 || snapshot.owners[0]!.allDocuments || snapshot.owners[0]!.qq !== candidate.owner.qq || snapshot.owners[0]!.tier !== candidate.owner.tier
            || snapshot.documents.some(id => !candidate.sourceManifest.some(item => item.documentId === id))) return 'blocked';
        if (!this.#current(candidate)) return this.#stopped ? 'stopped' : 'stale';
        let journal = snapshot.repair;
        const matching = journal && journal.lease.generation === candidate.generation && journal.lease.eventSetHash === candidate.eventSetHash
            && journal.lease.sourceManifestHash === candidate.sourceManifestHash && journal.lease.progressHash === candidate.progressHash ? journal.lease.repairId : undefined;
        if (snapshot.unresolvedRepairIds.some(id => id !== matching)) return 'blocked';
        if (!journal || journal.lease.generation !== candidate.generation || journal.lease.eventSetHash !== candidate.eventSetHash
            || journal.lease.sourceManifestHash !== candidate.sourceManifestHash || journal.lease.progressHash !== candidate.progressHash) {
            const lease = store.beginRepair(candidate.bankId, { expectedGeneration: candidate.generation, eventSetHash: candidate.eventSetHash,
                sourceManifestHash: candidate.sourceManifestHash, sourceManifest: candidate.sourceManifest, owner: candidate.owner, progressHash: candidate.progressHash });
            journal = { lease, phase: 'baseline', evidence: {} };
        }
        const lease = journal.lease;
        if (journal.evidence.originalAutomatic !== undefined && journal.evidence.originalAutomatic !== candidate.expectedAutomatic
            || journal.evidence.originalCadence !== undefined && journal.evidence.originalCadence !== candidate.expectedCadence) return this.#blocked(lease, 'evidence-mismatch');
        // Each turn can advance a finite number of phases; waiting never spins or sleeps.
        for (let step = 0; step < 12; step++) {
            if (!this.#current(candidate)) return this.#stopped ? 'stopped' : 'stale';
            const live = store.snapshot(candidate.bankId).repair;
            if (!live || live.lease.repairId !== lease.repairId) return 'stale';
            const e = live.evidence;
            switch (live.phase) {
                case 'blocked': return 'blocked';
                case 'baseline': {
                    const stats = await this.#idle(candidate); if (!stats) return 'waiting';
                    const inventory = await this.#inventory(candidate); if (!inventory) return 'waiting';
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#identity(candidate, model) || model.trigger.refresh_after_consolidation !== candidate.expectedAutomatic
                        || model.trigger.min_refresh_interval_seconds !== candidate.expectedCadence) return this.#blocked(lease, 'evidence-mismatch');
                    this.#checkpoint(lease, 'pause-dispatched', { initialWatermark: stats.last_memory_write_at!, inventoryHash: inventory,
                        modelIdentityHash: candidate.modelIdentityHash, originalAutomatic: candidate.expectedAutomatic, originalCadence: candidate.expectedCadence });
                    await this.#mutation(() => api.repairConfigureModel(candidate.bankId, MODEL), configured => {
                        if (!this.#safe(candidate, configured)) throw new Error('configuration mismatch');
                        this.#checkpoint(lease, 'paused', { safeConfigHash: configured.configuration_hash });
                    });
                    break;
                }
                case 'pause-dispatched': {
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model)) return this.#blocked(lease, 'dispatch-uncertain');
                    this.#checkpoint(lease, 'paused', { safeConfigHash: model.configuration_hash }); break;
                }
                case 'paused': {
                    const stats = await this.#idle(candidate); if (!stats) return 'waiting';
                    if (stats.last_memory_write_at !== e.initialWatermark || await this.#inventory(candidate) !== e.inventoryHash) return this.#blocked(lease, 'evidence-mismatch');
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model) || model.configuration_hash !== e.safeConfigHash) return this.#blocked(lease, 'evidence-mismatch');
                    this.#checkpoint(lease, 'clear-dispatched', {});
                    await this.#mutation(() => api.repairClearModel(candidate.bankId, MODEL), cleared => {
                        if (!this.#safe(candidate, cleared) || cleared.content !== '') throw new Error('clear not confirmed');
                        this.#checkpoint(lease, 'cleared', { clearContentHash: EMPTY });
                    }); break;
                }
                case 'clear-dispatched': {
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model) || model.content !== '') return this.#blocked(lease, 'dispatch-uncertain');
                    this.#checkpoint(lease, 'cleared', { clearContentHash: EMPTY }); break;
                }
                case 'cleared': {
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model) || model.content !== '') return this.#blocked(lease, 'evidence-mismatch');
                    this.#checkpoint(lease, 'refresh-dispatched', {});
                    await this.#mutation(() => api.repairRefreshModel(candidate.bankId, MODEL), id => {
                        if (!repairUuid(id)) throw new Error('missing operation identity');
                        this.#checkpoint(lease, 'refresh-pending', { refreshOperationId: id });
                    }); break;
                }
                case 'refresh-dispatched': return this.#blocked(lease, 'dispatch-uncertain');
                case 'refresh-pending': {
                    if (!e.refreshOperationId) return this.#blocked(lease, 'evidence-mismatch');
                    const operationId = e.refreshOperationId;
                    const op = await this.#read(() => api.repairRefreshOperation(candidate.bankId, operationId)); if (!this.#current(candidate)) return 'stale';
                    if (op.operation_id !== e.refreshOperationId || op.mental_model_id !== MODEL) return this.#blocked(lease, 'evidence-mismatch');
                    if (op.status === 'pending' || op.status === 'processing') return 'waiting';
                    if (op.status !== 'completed' || !['content_written', 'content_unchanged'].includes(op.outcome ?? '')) return this.#blocked(lease, 'operation-failed');
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model) || model.configuration_hash !== e.safeConfigHash || !validTime(model.last_memory_seen_at) || !validTime(model.last_refreshed_at)
                        || model.is_stale !== false) return this.#blocked(lease, 'evidence-mismatch');
                    this.#checkpoint(lease, 'restore-dispatched', { refreshOutcome: op.outcome as 'content_written' | 'content_unchanged',
                        modelContentHash: bodyHash(model.content ?? ''), modelSeenAt: model.last_memory_seen_at, modelRefreshedAt: model.last_refreshed_at, modelIsStale: false });
                    await this.#mutation(() => api.repairRestoreAutomatic(candidate.bankId, MODEL, candidate.expectedCadence, candidate.expectedAutomatic), restored => {
                        if (!this.#safe(candidate, restored, candidate.expectedAutomatic)) throw new Error('restore not confirmed');
                        this.#checkpoint(lease, 'restored', { restoredConfigHash: restored.configuration_hash });
                    }); break;
                }
                case 'restore-dispatched': {
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (!this.#safe(candidate, model, candidate.expectedAutomatic)) return this.#blocked(lease, 'dispatch-uncertain');
                    this.#checkpoint(lease, 'restored', { restoredConfigHash: model.configuration_hash }); break;
                }
                case 'restored': {
                    const stats = await this.#idle(candidate); if (!stats) return 'waiting';
                    const inventory = await this.#inventory(candidate); if (!inventory) return 'waiting';
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    if (stats.last_memory_write_at !== e.initialWatermark || inventory !== e.inventoryHash || !this.#safe(candidate, model, candidate.expectedAutomatic)
                        || model.configuration_hash !== e.restoredConfigHash || bodyHash(model.content ?? '') !== e.modelContentHash
                        || model.is_stale !== false || model.last_memory_seen_at !== e.modelSeenAt || model.last_refreshed_at !== e.modelRefreshedAt) return this.#blocked(lease, 'evidence-mismatch');
                    this.#checkpoint(lease, 'verified', { finalWatermark: stats.last_memory_write_at! }); break;
                }
                case 'verified': {
                    if (!this.#current(candidate)) return 'stale';
                    // A persisted verified checkpoint is not a lease on future provider state.
                    const inventory = await this.#inventory(candidate); if (!inventory) return 'waiting';
                    const model = await this.#read(() => api.repairModel(candidate.bankId, MODEL)); if (!this.#current(candidate)) return 'stale';
                    const stats = await this.#idle(candidate); if (!stats) return 'waiting';
                    if (inventory !== e.inventoryHash || stats.last_memory_write_at !== e.initialWatermark || !this.#safe(candidate, model, candidate.expectedAutomatic)
                        || model.configuration_hash !== e.restoredConfigHash || bodyHash(model.content ?? '') !== e.modelContentHash
                        || model.is_stale !== false || model.last_memory_seen_at !== e.modelSeenAt || model.last_refreshed_at !== e.modelRefreshedAt) return this.#blocked(lease, 'evidence-mismatch');
                    store.commitVerifiedRepair(lease, { ...e, sourceManifestHash: candidate.sourceManifestHash, progressHash: candidate.progressHash, eventSetHash: candidate.eventSetHash } as FinalEvidence);
                    return 'repaired';
                }
            }
        }
        return this.#stopped ? 'stopped' : 'waiting';
    }
}
