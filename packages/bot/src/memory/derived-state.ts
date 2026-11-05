import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONTACT_TIERS, UNLISTED_TIER } from '../platform/config.ts';
import { PHOTO_INDEX_LOCK_FILE, withPhotoIndexLock } from '../vision/photo-index-lock.ts';
import { fileOps, writeJsonAtomic } from './json-file.ts';

export interface DerivedOwner { qq: number; tier: string; allDocuments: boolean }
export interface DerivedSnapshot {
    generation: string;
    dirty: boolean;
    documents: readonly string[];
    owners: readonly DerivedOwner[];
}
type Owner = DerivedOwner & Record<string, unknown>;
type Bank = { generation: string; documents: string[]; owners: Owner[] } & Record<string, unknown>;
type State = { version: 1; banks: Record<string, Bank> } & Record<string, unknown>;
type Delta = { bankId: string; generation: string; qq: number; tier: string; documents?: string[] };
const CLEAN_GENERATION = '00000000-0000-0000-0000-000000000000';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const tier = (value: unknown): value is string => typeof value === 'string' && [...CONTACT_TIERS, UNLISTED_TIER].includes(value as typeof UNLISTED_TIER);
const owner = (value: unknown): value is Owner => object(value) && Number.isSafeInteger(value.qq) && (value.qq as number) > 0 && tier(value.tier) && typeof value.allDocuments === 'boolean';
function valid(value: unknown): value is State {
    return object(value) && value.version === 1 && object(value.banks) && Object.values(value.banks).every(bank =>
        object(bank) && uuid(bank.generation) && Array.isArray(bank.documents) && bank.documents.every(text)
        && new Set(bank.documents).size === bank.documents.length && Array.isArray(bank.owners) && bank.owners.length > 0
        && bank.owners.every(owner) && new Set(bank.owners.map(item => `${item.qq}:${item.tier}`)).size === bank.owners.length);
}
export { valid as isDerivedState };

/** Monotone evidence only: no implicit expiry or clearing of derived-data contamination. */
export class DerivedState {
    readonly #dir: string;
    readonly #path: string;
    readonly #pending: Delta[] = [];
    #seenState = false;
    constructor(dir: string) { this.#dir = dir; this.#path = join(dir, 'derived.json'); }

    mark(bankId: string, input: { qq: number; tier: string; documents?: readonly string[] }): void {
        this.markMany([{ bankId, ...input }]);
    }

    /** 私人/公共污染必须同次发布，不能在两次mark之间留下崩溃解封窗口。 */
    markMany(inputs: readonly { bankId: string; qq: number; tier: string; documents?: readonly string[] }[]): void {
        if (!Array.isArray(inputs) || !inputs.length || !inputs.every(input => object(input) && text(input.bankId)
            && owner({ ...input, allDocuments: true })
            && (input.documents === undefined || Array.isArray(input.documents) && input.documents.every(text)))) {
            throw new Error('派生记忆屏障输入无效');
        }
        const accepted: readonly { bankId: string; qq: number; tier: string; documents?: readonly string[] }[] = inputs;
        this.#pending.push(...accepted.map(input => ({ bankId: input.bankId, generation: randomUUID(), qq: input.qq, tier: input.tier,
            ...(input.documents === undefined ? {} : { documents: [...new Set(input.documents)] }) })));
        this.#access(inputs[0]!.bankId);
    }

    snapshot(bankId: string): DerivedSnapshot {
        if (!text(bankId)) throw new Error('派生记忆屏障输入无效');
        return this.#access(bankId);
    }

    #read(allowMissing = false): State | undefined {
        let raw: string;
        try { raw = fileOps.readFileSync(this.#path, 'utf8'); }
        catch (error) { if (allowMissing && (error as { code?: unknown })?.code === 'ENOENT') return undefined; throw error; }
        const parsed: unknown = JSON.parse(raw);
        if (!valid(parsed)) throw new Error('invalid schema');
        this.#seenState = true;
        return parsed;
    }

    #access(bankId: string): DerivedSnapshot {
        try {
            // The coordinator's existence witnesses prior initialization; JSON remains authoritative.
            // Observe before acquiring, because acquisition itself creates this file.
            let witnessed = true;
            try { statSync(join(this.#dir, PHOTO_INDEX_LOCK_FILE)); }
            catch (error) { if ((error as { code?: unknown })?.code === 'ENOENT') witnessed = false; else throw error; }
            return withPhotoIndexLock(this.#dir, () => {
                const loaded = this.#read(!witnessed && !this.#seenState);
                const state: State = loaded ?? { version: 1, banks: {} };
                if (!loaded || this.#pending.length) {
                    for (const delta of this.#pending) {
                        let bank = Object.hasOwn(state.banks, delta.bankId) ? state.banks[delta.bankId] : undefined;
                        if (!bank) {
                            bank = { generation: delta.generation, documents: [], owners: [] };
                            Object.defineProperty(state.banks, delta.bankId, { value: bank, enumerable: true, writable: true, configurable: true });
                        }
                        bank.generation = delta.generation;
                        const existing = bank.owners.find(item => item.qq === delta.qq && item.tier === delta.tier);
                        if (existing) existing.allDocuments ||= delta.documents === undefined;
                        else bank.owners.push({ qq: delta.qq, tier: delta.tier, allDocuments: delta.documents === undefined });
                        bank.documents = [...new Set([...bank.documents, ...delta.documents ?? []])];
                    }
                    try { writeJsonAtomic(this.#path, state); }
                    catch (error) { if (!isDeepStrictEqual(this.#read(), state)) throw error; }
                    this.#pending.length = 0;
                    this.#seenState = true;
                }
                const bank = Object.hasOwn(state.banks, bankId) ? state.banks[bankId] : undefined;
                return bank ? structuredClone({ generation: bank.generation, dirty: true, documents: bank.documents,
                    owners: bank.owners.map(({ qq, tier, allDocuments }) => ({ qq, tier, allDocuments })) })
                    : { generation: CLEAN_GENERATION, dirty: false, documents: [], owners: [] };
            });
        } catch { throw new Error('派生记忆屏障不可用；拒绝使用未确认的派生内容'); }
    }
}
