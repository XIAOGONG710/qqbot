import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPhotoIndexLock } from '../vision/photo-index-lock.ts';
import { fileOps, writeJsonAtomic } from './json-file.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';
import type { MemoryItem } from './hindsight.ts';

export const WRITTEN_RETAIN_FILE = 'written-retain.json';
export const WRITTEN_RETAIN_MARKER = 'written-retain.initialized';
export const WRITTEN_RETAIN_COORDINATION_DIRECTORY = 'written-retain-coordination';
export interface WrittenRetainOptions { operationId?: string; allowSubmit?: boolean; canSubmit?: (signal?: AbortSignal) => boolean | Promise<boolean> }
export interface WrittenOperation { bankId: string; documentId: string; operationId: string; requestHash: string; item: MemoryItem; phase: 'prepared' | 'dispatched' | 'completed' }
export interface WrittenRetainState { version: 1; operations: Record<string, WrittenOperation>; current: Record<string, string>; blockedBanks: Record<string, { documents: string[] }> }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : stateObject(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const writtenRequestHash = (item: MemoryItem): string => createHash('sha256').update(JSON.stringify(canonical(item))).digest('hex');
const key = (bank: string, doc: string) => createHash('sha256').update(JSON.stringify([bank, doc])).digest('hex');
const fail = () => new Error('日记提交协议状态无效或读写未确认；原件保留，暂停派发');
const doc = (v: unknown): v is string => typeof v === 'string' && /^(?:diary:|week:|phase:)/.test(v) && text(v);
const itemValid = (v: unknown): v is MemoryItem => stateObject(v) && typeof v.content === 'string' && stateTimestamp(v.timestamp)
    && typeof v.context === 'string' && doc(v.document_id) && Array.isArray(v.tags) && v.tags.every(text)
    && stateObject(v.metadata) && Array.isArray(v.entities) && v.entities.every(e => stateObject(e) && text(e.text) && text(e.type));
export function isWrittenRetainState(v: unknown): v is WrittenRetainState {
    if (!stateObject(v) || v.version !== 1 || !stateObject(v.operations) || !stateObject(v.current) || !stateObject(v.blockedBanks)) return false;
    if (!Object.entries(v.operations).every(([id, op]) => uuid(id) && stateObject(op) && op.operationId === id && text(op.bankId) && doc(op.documentId)
        && itemValid(op.item) && op.item.document_id === op.documentId && hash(op.requestHash) && writtenRequestHash(op.item) === op.requestHash
        && ['prepared', 'dispatched', 'completed'].includes(op.phase as string))) return false;
    const operations = v.operations as Record<string, WrittenOperation>;
    if (!Object.entries(v.current).every(([k, id]) => hash(k) && uuid(id) && Object.hasOwn(operations, id) && key(operations[id]!.bankId, operations[id]!.documentId) === k)) return false;
    // A non-current unresolved operation cannot be bypassed by a newer request.
    const current = v.current;
    if (Object.values(operations).some(op => op.phase !== 'completed' && current[key(op.bankId, op.documentId)] !== op.operationId)) return false;
    return Object.entries(v.blockedBanks).every(([bank, block]) => text(bank) && stateObject(block) && Array.isArray(block.documents)
        && block.documents.length > 0 && block.documents.every(doc) && new Set(block.documents).size === block.documents.length);
}
const empty = (): WrittenRetainState => ({ version: 1, operations: {}, current: {}, blockedBanks: {} });
const put = <T>(o: Record<string, T>, k: string, value: T) => Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true });

/** The bot owns the async lifecycle; the short OS mutex protects JSON deltas only. */
export class WrittenRetainStore {
    readonly #dir: string;
    readonly #observed = new Map<string, Set<string>>();
    constructor(dir: string) { this.#dir = dir; }
    #regular(path: string): boolean {
        try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw fail(); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw fail(); }
    }
    #read(): WrittenRetainState {
        const path = join(this.#dir, WRITTEN_RETAIN_FILE), marker = join(this.#dir, WRITTEN_RETAIN_MARKER);
        try {
            const marked = this.#regular(marker);
            if (marked && lstatSync(marker).size !== 0) throw fail();
            if (!this.#regular(path)) { if (marked) throw fail(); return empty(); }
            const value: unknown = JSON.parse(fileOps.readFileSync(path, 'utf8'));
            if (!isWrittenRetainState(value)) throw fail(); return value;
        } catch { throw fail(); }
    }
    #save(state: WrittenRetainState): void {
        if (!isWrittenRetainState(state)) throw fail();
        const path = join(this.#dir, WRITTEN_RETAIN_FILE), marker = join(this.#dir, WRITTEN_RETAIN_MARKER);
        try { writeJsonAtomic(path, state); }
        catch { try { if (JSON.stringify(canonical(this.#read())) !== JSON.stringify(canonical(state))) throw fail(); } catch { throw fail(); } }
        // No RPC can start until both the authoritative JSON and its existence witness exist.
        try { if (!this.#regular(marker)) writeFileSync(marker, '', { flag: 'wx' }); }
        catch { throw fail(); }
    }
    #with<T>(work: (state: WrittenRetainState) => { result: T; changed?: boolean }): T {
        try {
            for (const path of [this.#dir, join(this.#dir, WRITTEN_RETAIN_COORDINATION_DIRECTORY)]) {
                try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail(); }
            }
            mkdirSync(this.#dir, { recursive: true });
            return withPhotoIndexLock(join(this.#dir, WRITTEN_RETAIN_COORDINATION_DIRECTORY), () => {
                const state = this.#read(); let dirty = false;
                for (const [bank, docs] of this.#observed) {
                    const old = state.blockedBanks[bank]?.documents ?? [], merged = [...new Set([...old, ...docs])].sort();
                    if (JSON.stringify(old) !== JSON.stringify(merged)) { put(state.blockedBanks, bank, { documents: merged }); dirty = true; }
                }
                const { result, changed } = work(state);
                if (dirty || changed) this.#save(state);
                this.#observed.clear(); return { value: result };
            }).value;
        } catch { throw fail(); }
    }
    snapshot(): WrittenRetainState { return this.#with(state => ({ result: structuredClone(state) })); }
    current(bank: string, document: string): WrittenOperation | undefined {
        return this.#with(state => ({ result: structuredClone(state.operations[state.current[key(bank, document)]!]) }));
    }
    operation(id: string): WrittenOperation | undefined { return this.#with(state => ({ result: structuredClone(state.operations[id]) })); }
    prepare(bank: string, item: MemoryItem, operationId?: string): WrittenOperation {
        if (!text(bank) || !itemValid(item) || operationId !== undefined && !uuid(operationId)) throw fail();
        const frozen = structuredClone(item), digest = writtenRequestHash(frozen), document = frozen.document_id!;
        return this.#with(state => {
            const existing = operationId ? state.operations[operationId] : state.operations[state.current[key(bank, document)]!];
            if (existing && existing.bankId === bank && existing.documentId === document && existing.requestHash === digest) return { result: structuredClone(existing) };
            if (existing && operationId || Object.values(state.operations).some(op => op.bankId === bank && op.documentId === document && op.phase !== 'completed')) throw fail();
            const id = operationId ?? randomUUID(), op: WrittenOperation = { bankId: bank, documentId: document, operationId: id, requestHash: digest, item: frozen, phase: 'prepared' };
            put(state.operations, id, op); put(state.current, key(bank, document), id);
            return { result: structuredClone(op), changed: true };
        });
    }
    phase(id: string, phase: WrittenOperation['phase']): void {
        this.#with(state => {
            const op = state.operations[id]; if (!op || op.phase === 'completed' && phase !== 'completed' || phase === 'prepared') throw fail();
            const changed = op.phase !== phase; op.phase = phase; return { result: undefined, changed };
        });
    }
    markSourceChanged(bank: string, document: string): void {
        if (!text(bank) || !doc(document)) throw fail();
        const docs = this.#observed.get(bank) ?? new Set<string>(); docs.add(document); this.#observed.set(bank, docs);
        this.#with(() => ({ result: undefined }));
    }
    blockedDocuments(bank: string): string[] { return this.#with(state => ({ result: [...state.blockedBanks[bank]?.documents ?? []] })); }
}
