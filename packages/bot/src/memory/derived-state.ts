import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONTACT_TIERS, UNLISTED_TIER } from '../platform/config.ts';
import { PHOTO_INDEX_LOCK_FILE, withPhotoIndexLock } from '../vision/photo-index-lock.ts';
import { fileOps, writeJsonAtomic } from './json-file.ts';
import { isFinalEvidence, isRepairCheckpointEvidence, isRepairJournal, isRepairLease, repairCompareTimestamps, repairHash, repairSourceManifestHash, REPAIR_PHASES,
    type FinalEvidence, type RepairCheckpointEvidence, type RepairJournal, type RepairLease, type RepairOwner, type RepairPhase, type RepairReceipt, type RepairSourceDocument } from './derived-repair-protocol.ts';

export interface DerivedOwner { qq: number; tier: string; allDocuments: boolean }
export interface DerivedSnapshot {
    generation: string;
    dirty: boolean;
    documents: readonly string[];
    owners: readonly DerivedOwner[];
    allOwners: readonly DerivedOwner[];
    activeEventIds: readonly string[];
    eventSetHash: string;
    /** All generations: an uncertain mutation must not be bypassed by a newer lease. */
    unresolvedRepairIds: readonly string[];
    repair?: RepairJournal;
}
type Owner = DerivedOwner & Record<string, unknown>;
type Event = { owner: DerivedOwner; documents: string[]; status: 'active' | 'repaired'; legacy?: true; receipt?: string };
type Journal = RepairJournal & { owner: RepairOwner; sourceManifest: RepairSourceDocument[] };
type Receipt = { lease: RepairLease; evidence: FinalEvidence; generation: string };
type Bank = { generation: string; documents: string[]; owners: Owner[]; events: Record<string, Event>; journals?: Record<string, Journal>; currentRepair?: string; receipts?: Record<string, Receipt> } & Record<string, unknown>;
type State = { version: 1 | 2; banks: Record<string, Bank> } & Record<string, unknown>;
type Delta = { bankId: string; generation: string; qq: number; tier: string; documents?: string[]; eventKey: string };
export interface DerivedMark { bankId: string; qq: number; tier: string; documents?: readonly string[]; eventKey?: string }
export interface BeginRepair { expectedGeneration: string; eventSetHash: string; sourceManifestHash: string; sourceManifest: readonly RepairSourceDocument[]; owner: RepairOwner; progressHash: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = (bank: Bank) => Object.entries(bank.events).filter(([, event]) => event.status === 'active').sort(([a], [b]) => a.localeCompare(b));
const eventHash = (bank: Bank) => hash(active(bank).map(([id, event]) => [id, event.owner, event.documents]));
const unresolvedRepairs = (bank: Bank): string[] => Object.entries(bank.journals ?? {}).filter(([, journal]) =>
    ['pause-dispatched', 'clear-dispatched', 'refresh-dispatched', 'refresh-pending', 'restore-dispatched', 'blocked'].includes(journal.phase)).map(([id]) => id).sort();
const put = <T>(target: Record<string, T>, key: string, value: T) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
const validManifest = (value: unknown): value is RepairSourceDocument[] => Array.isArray(value) && new Set(value.map(doc => object(doc) ? doc.documentId : undefined)).size === value.length
    && value.every(doc => object(doc) && Object.keys(doc).every(key => ['documentId', 'episodeDigest', 'contentHash', 'count'].includes(key))
        && typeof doc.documentId === 'string' && /^ep--?\d+$/.test(doc.documentId) && repairHash(doc.episodeDigest) && repairHash(doc.contentHash) && Number.isSafeInteger(doc.count) && Number(doc.count) >= 0);
const validRepairBank = (bank: Record<string, unknown>, bankId: string): boolean => {
    if (bank.journals !== undefined && (!object(bank.journals) || !Object.entries(bank.journals).every(([id, journal]) => isRepairJournal(journal) && journal.lease.repairId === id
        && journal.lease.bankId === bankId && object(journal) && object(journal.owner) && owner({ ...journal.owner, allDocuments: false }) && validManifest(journal.sourceManifest)
        && repairSourceManifestHash(journal.sourceManifest) === journal.lease.sourceManifestHash))) return false;
    if (bank.currentRepair !== undefined && (typeof bank.currentRepair !== 'string' || !object(bank.journals) || !Object.hasOwn(bank.journals, bank.currentRepair))) return false;
    if (bank.receipts !== undefined && (!object(bank.receipts) || !Object.entries(bank.receipts).every(([id, receipt]) => object(receipt) && isRepairLease(receipt.lease)
        && receipt.lease.bankId === bankId && receipt.lease.repairId === id && isFinalEvidence(receipt.evidence) && uuid(receipt.generation)
        && object(bank.journals) && Object.hasOwn(bank.journals, id)))) return false;
    if (!object(bank.events)) return false;
    if (!Object.values(bank.events).every(event => object(event) && owner(event.owner) && Array.isArray(bank.owners) && bank.owners.some(item => owner(item)
        && item.qq === (event.owner as Owner).qq && item.tier === (event.owner as Owner).tier && (!(event.owner as Owner).allDocuments || item.allDocuments))
        && Array.isArray(event.documents) && event.documents.every(id => Array.isArray(bank.documents) && bank.documents.includes(id))
        && (event.status !== 'repaired' || object(bank.receipts) && typeof event.receipt === 'string' && Object.hasOwn(bank.receipts, event.receipt)))) return false;
    for (const [id, receipt] of Object.entries(bank.receipts ?? {}) as [string, Receipt][]) {
        const journal = (bank.journals as Record<string, Journal> | undefined)?.[id];
        if (!journal || journal.phase !== 'verified' || !isDeepStrictEqual(journal.lease, receipt.lease) || receipt.generation === receipt.lease.generation) return false;
        const { sourceManifestHash, progressHash, eventSetHash, ...proof } = receipt.evidence;
        if (sourceManifestHash !== receipt.lease.sourceManifestHash || progressHash !== receipt.lease.progressHash || eventSetHash !== receipt.lease.eventSetHash
            || !isDeepStrictEqual(journal.evidence, proof)) return false;
        const repaired = Object.entries(bank.events).filter(([, event]) => object(event) && event.receipt === id).sort(([a], [b]) => a.localeCompare(b));
        if (hash(repaired.map(([key, event]) => [key, (event as Event).owner, (event as Event).documents])) !== eventSetHash) return false;
    }
    return true;
};
const CLEAN_GENERATION = '00000000-0000-0000-0000-000000000000';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const tier = (value: unknown): value is string => typeof value === 'string' && [...CONTACT_TIERS, UNLISTED_TIER].includes(value as typeof UNLISTED_TIER);
const owner = (value: unknown): value is Owner => object(value) && Number.isSafeInteger(value.qq) && (value.qq as number) > 0 && tier(value.tier) && typeof value.allDocuments === 'boolean';
function valid(value: unknown): value is State {
    return object(value) && (value.version === 1 || value.version === 2) && object(value.banks) && Object.entries(value.banks).every(([bankId, bank]) =>
        object(bank) && uuid(bank.generation) && Array.isArray(bank.documents) && bank.documents.every(text)
        && new Set(bank.documents).size === bank.documents.length && Array.isArray(bank.owners) && bank.owners.length > 0
        && bank.owners.every(owner) && new Set(bank.owners.map(item => `${item.qq}:${item.tier}`)).size === bank.owners.length
        && (value.version === 1 || object(bank.events) && Object.entries(bank.events).every(([key, event]) => text(key) && object(event)
            && owner(event.owner) && Array.isArray(event.documents) && event.documents.every(text) && new Set(event.documents).size === event.documents.length
            && (event.status === 'active' || event.status === 'repaired' && uuid(event.receipt)) && (event.legacy === undefined || event.legacy === true)) && validRepairBank(bank, bankId)));
}
export { valid as isDerivedState };

/** Monotone evidence only: no implicit expiry or clearing of derived-data contamination. */
export class DerivedState {
    readonly #dir: string;
    readonly #path: string;
    readonly #pending: Delta[] = [];
    #seenState = false;
    #migrationPending = false;
    constructor(dir: string) { this.#dir = dir; this.#path = join(dir, 'derived.json'); }

    mark(bankId: string, input: Omit<DerivedMark, 'bankId'>): void {
        this.markMany([{ bankId, ...input }]);
    }

    /** 私人/公共污染必须同次发布，不能在两次mark之间留下崩溃解封窗口。 */
    markMany(inputs: readonly DerivedMark[]): void {
        if (!Array.isArray(inputs) || !inputs.length || !inputs.every(input => object(input) && text(input.bankId)
            && owner({ ...input, allDocuments: true })
            && (input.documents === undefined || Array.isArray(input.documents) && input.documents.every(text)) && (input.eventKey === undefined || text(input.eventKey)))) {
            throw new Error('派生记忆屏障输入无效');
        }
        const accepted: readonly DerivedMark[] = inputs;
        this.#pending.push(...accepted.map(input => ({ bankId: input.bankId, generation: randomUUID(), qq: input.qq, tier: input.tier,
            eventKey: input.eventKey ?? `unkeyed:${randomUUID()}`, ...(input.documents === undefined ? {} : { documents: [...new Set(input.documents)].sort() }) })));
        this.#access(inputs[0]!.bankId);
    }

    snapshot(bankId: string): DerivedSnapshot {
        if (!text(bankId)) throw new Error('派生记忆屏障输入无效');
        return this.#access(bankId);
    }

    beginRepair(bankId: string, input: BeginRepair): RepairLease {
        if (!text(bankId) || !object(input) || !uuid(input.expectedGeneration) || !repairHash(input.eventSetHash) || !repairHash(input.progressHash)
            || !owner({ ...input.owner, allDocuments: false }) || !validManifest(input.sourceManifest) || repairSourceManifestHash(input.sourceManifest) !== input.sourceManifestHash) throw new Error('派生修订证据无效');
        return this.#access(bankId, state => {
            const bank = this.#candidate(state, bankId, input.expectedGeneration, input.eventSetHash, input.owner, input.sourceManifest);
            const previous = bank.currentRepair ? bank.journals?.[bank.currentRepair] : undefined;
            if (previous && previous.lease.generation === bank.generation) {
                if (unresolvedRepairs(bank).some(id => id !== previous.lease.repairId)) throw new Error('旧派发尚未确认');
                if (previous.lease.sourceManifestHash !== input.sourceManifestHash || previous.lease.progressHash !== input.progressHash) throw new Error('来源已变');
                return structuredClone(previous.lease);
            }
            if (unresolvedRepairs(bank).length) throw new Error('旧派发尚未确认');
            const lease: RepairLease = { bankId, repairId: randomUUID(), generation: bank.generation, eventSetHash: input.eventSetHash, sourceManifestHash: input.sourceManifestHash, progressHash: input.progressHash };
            bank.journals ??= {}; put(bank.journals, lease.repairId, { lease, phase: 'baseline', evidence: {}, owner: { qq: input.owner.qq, tier: input.owner.tier }, sourceManifest: structuredClone([...input.sourceManifest]) }); bank.currentRepair = lease.repairId;
            return structuredClone(lease);
        });
    }

    checkpoint(lease: RepairLease, phase: RepairPhase, evidence: RepairCheckpointEvidence): void {
        if (!isRepairLease(lease) || !isRepairCheckpointEvidence(evidence) || !isRepairJournal({ lease, phase, evidence })) throw new Error('派生修订检查点无效');
        this.#access(lease.bankId, state => {
            const journal = state.banks[lease.bankId]?.journals?.[lease.repairId];
            if (!journal || !isDeepStrictEqual(journal.lease, lease)) throw new Error('租约未知');
            const sequence: readonly RepairPhase[] = REPAIR_PHASES.filter(step => step !== 'blocked');
            if (journal.phase === 'blocked' && phase !== 'blocked' || phase !== 'blocked' && (sequence.indexOf(phase) < sequence.indexOf(journal.phase) || sequence.indexOf(phase) > sequence.indexOf(journal.phase) + 1)) throw new Error('检查点顺序无效');
            const provided = Object.fromEntries(Object.entries(evidence).filter(([, value]) => value !== undefined)) as RepairCheckpointEvidence;
            for (const [key, value] of Object.entries(provided)) if (Object.hasOwn(journal.evidence, key) && journal.evidence[key as keyof RepairCheckpointEvidence] !== value) throw new Error('证据不可改绑');
            const merged = { ...journal.evidence, ...structuredClone(provided) };
            const fields: (keyof RepairCheckpointEvidence)[] = ['initialWatermark', 'inventoryHash', 'modelIdentityHash', 'originalAutomatic', 'originalCadence'];
            const required = (at: RepairPhase, ...keys: (keyof RepairCheckpointEvidence)[]) => { if (phase !== 'blocked' && sequence.indexOf(phase) >= sequence.indexOf(at)) fields.push(...keys); };
            required('paused', 'safeConfigHash'); required('cleared', 'clearContentHash'); required('refresh-pending', 'refreshOperationId');
            required('restore-dispatched', 'refreshOutcome', 'modelContentHash', 'modelIsStale', 'modelSeenAt', 'modelRefreshedAt');
            required('restored', 'restoredConfigHash'); required('verified', 'finalWatermark');
            if (phase === 'blocked' ? merged.blockedReason === undefined : phase !== 'baseline' && fields.some(key => merged[key] === undefined)) throw new Error('检查点证据不完整');
            journal.evidence = merged; journal.phase = phase;
        });
    }

    commitVerifiedRepair(lease: RepairLease, evidence: FinalEvidence): RepairReceipt {
        if (!isRepairLease(lease) || !isFinalEvidence(evidence)) throw new Error('派生修订完成证据无效');
        return this.#access(lease.bankId, state => {
            const bank = state.banks[lease.bankId], previous = bank?.receipts?.[lease.repairId];
            if (previous) { if (!isDeepStrictEqual(previous.lease, lease) || !isDeepStrictEqual(previous.evidence, evidence)) throw new Error('收据不可改绑'); return { repairId: lease.repairId, generation: previous.generation }; }
            const journal = bank?.journals?.[lease.repairId];
            if (!journal || !isDeepStrictEqual(journal.lease, lease) || bank.currentRepair !== lease.repairId || journal.phase !== 'verified') throw new Error('尚未验证');
            if (unresolvedRepairs(bank).some(id => id !== lease.repairId)) throw new Error('旧派发尚未确认');
            this.#candidate(state, lease.bankId, lease.generation, lease.eventSetHash, journal.owner, journal.sourceManifest);
            const { sourceManifestHash, progressHash, eventSetHash, ...proof } = evidence;
            if (sourceManifestHash !== lease.sourceManifestHash || progressHash !== lease.progressHash || eventSetHash !== lease.eventSetHash
                || !isDeepStrictEqual(journal.evidence, proof) || evidence.clearContentHash !== createHash('sha256').update('').digest('hex')
                || repairCompareTimestamps(evidence.initialWatermark, evidence.finalWatermark) !== 0 || evidence.modelIsStale !== false) throw new Error('完成证据不匹配');
            const generation = randomUUID(); bank.receipts ??= {}; put(bank.receipts, lease.repairId, { lease: structuredClone(lease), evidence: structuredClone(evidence), generation });
            for (const [, event] of active(bank)) { event.status = 'repaired'; event.receipt = lease.repairId; } bank.generation = generation;
            return { repairId: lease.repairId, generation };
        });
    }

    #candidate(state: State, bankId: string, generation: string, events: string, who: RepairOwner, source: readonly RepairSourceDocument[]): Bank {
        const bank = Object.hasOwn(state.banks, bankId) ? state.banks[bankId] : undefined;
        const suffix = createHash('sha256').update(`qqbot:${who.qq}-${who.tier}`).digest('hex').slice(0, 16), ids = new Set(source.map(doc => doc.documentId));
        if (!bank || bank.generation !== generation || eventHash(bank) !== events || !active(bank).length || !new RegExp(`^[A-Za-z0-9-]+-${suffix}$`).test(bankId)
            || active(bank).some(([, event]) => event.owner.qq !== who.qq || event.owner.tier !== who.tier || event.owner.allDocuments || !event.documents.length
                || event.documents.some(id => !/^ep--?\d+$/.test(id) || !ids.has(id)))) throw new Error('修订范围或世代不匹配');
        return bank;
    }

    #read(allowMissing = false): State | undefined {
        let raw: string;
        try { raw = fileOps.readFileSync(this.#path, 'utf8'); }
        catch (error) { if (allowMissing && (error as { code?: unknown })?.code === 'ENOENT') return undefined; throw error; }
        const parsed: unknown = JSON.parse(raw);
        if (!valid(parsed)) throw new Error('invalid schema');
        this.#seenState = true;
        if (parsed.version === 1) {
            for (const bank of Object.values(parsed.banks)) {
                bank.events = {};
                for (const item of bank.owners) Object.defineProperty(bank.events, `legacy:${bank.generation}:${item.qq}:${item.tier}`, {
                    value: { owner: { qq: item.qq, tier: item.tier, allDocuments: item.allDocuments }, documents: [...bank.documents].sort(), status: 'active', legacy: true }, enumerable: true, writable: true, configurable: true });
            }
            parsed.version = 2; this.#migrationPending = true;
        }
        return parsed;
    }

    #access<T = DerivedSnapshot>(bankId: string, mutate?: (state: State) => T): T {
        try {
            // The coordinator's existence witnesses prior initialization; JSON remains authoritative.
            // Observe before acquiring, because acquisition itself creates this file.
            let witnessed = true;
            try { statSync(join(this.#dir, PHOTO_INDEX_LOCK_FILE)); }
            catch (error) { if ((error as { code?: unknown })?.code === 'ENOENT') witnessed = false; else throw error; }
            const access = withPhotoIndexLock(this.#dir, () => {
                const loaded = this.#read(!witnessed && !this.#seenState);
                const state: State = loaded ?? { version: 2, banks: {} };
                const before = structuredClone(state);
                let result: T | undefined;
                if (!loaded || this.#pending.length || this.#migrationPending || mutate) {
                    for (const delta of this.#pending) {
                        let bank = Object.hasOwn(state.banks, delta.bankId) ? state.banks[delta.bankId] : undefined;
                        if (!bank) {
                            bank = { generation: delta.generation, documents: [], owners: [], events: {} };
                            Object.defineProperty(state.banks, delta.bankId, { value: bank, enumerable: true, writable: true, configurable: true });
                        }
                        const scope = { owner: { qq: delta.qq, tier: delta.tier, allDocuments: delta.documents === undefined }, documents: [...delta.documents ?? []] };
                        const previous = Object.hasOwn(bank.events, delta.eventKey) ? bank.events[delta.eventKey] : undefined;
                        if (previous) {
                            if (!isDeepStrictEqual({ owner: previous.owner, documents: previous.documents }, scope)) throw new Error('event scope conflict');
                            continue;
                        }
                        Object.defineProperty(bank.events, delta.eventKey, { value: { ...scope, status: 'active' }, enumerable: true, configurable: true, writable: true });
                        bank.generation = delta.generation;
                        const existing = bank.owners.find(item => item.qq === delta.qq && item.tier === delta.tier);
                        if (existing) existing.allDocuments ||= delta.documents === undefined;
                        else bank.owners.push({ qq: delta.qq, tier: delta.tier, allDocuments: delta.documents === undefined });
                        bank.documents = [...new Set([...bank.documents, ...delta.documents ?? []])];
                    }
                    result = mutate?.(state);
                    if (!valid(state)) throw new Error('invalid state');
                    try { if (!loaded || this.#migrationPending || !isDeepStrictEqual(before, state)) writeJsonAtomic(this.#path, state); }
                    catch (error) { if (!isDeepStrictEqual(this.#read(), state)) throw error; }
                    this.#pending.length = 0;
                    this.#migrationPending = false;
                    this.#seenState = true;
                }
                if (mutate) return { value: result as T };
                const bank = Object.hasOwn(state.banks, bankId) ? state.banks[bankId] : undefined;
                if (!bank) return { value: { generation: CLEAN_GENERATION, dirty: false, documents: [], owners: [], allOwners: [], activeEventIds: [], eventSetHash: hash([]), unresolvedRepairIds: [] } as T };
                const events = active(bank), owners: DerivedOwner[] = [];
                for (const event of Object.values(bank.events).filter(event => event.status === 'active')) { const previous = owners.find(item => item.qq === event.owner.qq && item.tier === event.owner.tier);
                    if (previous) previous.allDocuments ||= event.owner.allDocuments; else owners.push({ ...event.owner }); }
                const documents = new Set(events.flatMap(([, event]) => event.documents));
                const repair = bank.currentRepair ? bank.journals?.[bank.currentRepair] : undefined;
                return { value: structuredClone({ generation: bank.generation, dirty: events.length > 0, documents: bank.documents.filter(document => documents.has(document)), owners,
                    allOwners: bank.owners.map(({ qq, tier, allDocuments }) => ({ qq, tier, allDocuments })), activeEventIds: events.map(([id]) => id), eventSetHash: eventHash(bank),
                    unresolvedRepairIds: unresolvedRepairs(bank),
                    ...(repair ? { repair: { lease: repair.lease, phase: repair.phase, evidence: repair.evidence } } : {}) }) as T };
            });
            return access.value;
        } catch { throw new Error('派生记忆屏障不可用；拒绝使用未确认的派生内容'); }
    }
}
