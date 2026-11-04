import { randomBytes } from 'node:crypto';
import { MAX_CLOCK_SKEW_MS, MAX_MEDIA_BYTES } from './protocol.ts';

export interface CompanionMediaRecord {
    mediaId: string;
    clientId: string;
    mime: string;
    bytes: number;
    data: Buffer;
    createdAt: number;
    expiresAt: number;
    durationMs?: number;
    width?: number;
    height?: number;
}

export interface CompanionMediaStore {
    put(input: Omit<CompanionMediaRecord, 'mediaId' | 'createdAt' | 'expiresAt'> & { now?: number }): CompanionMediaRecord;
    get(clientId: string, mediaId: string, now?: number): CompanionMediaRecord | undefined;
    /** 设备撤销配对时立即清掉该设备尚未过期的媒体。 */
    clear(clientId?: string, now?: number): number;
    purge(now?: number): number;
}

export interface MemoryCompanionMediaStoreOptions {
    ttlMs?: number;
    maxItems?: number;
    maxItemsPerClient?: number;
    maxTotalBytes?: number;
    now?: () => number;
    id?: () => string;
}

const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_ITEMS_PER_CLIENT = 16;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 仅存内存、短 TTL、按设备隔离的媒体仓库；不写磁盘，也不接受任意 MIME。 */
export class MemoryCompanionMediaStore implements CompanionMediaStore {
    private readonly ttlMs: number;
    private readonly maxItems: number;
    private readonly maxItemsPerClient: number;
    private readonly maxTotalBytes: number;
    private readonly now: () => number;
    private readonly id: () => string;
    private readonly records = new Map<string, CompanionMediaRecord>();
    private totalBytes = 0;

    constructor(options: MemoryCompanionMediaStoreOptions = {}) {
        this.ttlMs = bounded(options.ttlMs ?? DEFAULT_TTL_MS, 10_000, 24 * 60 * 60_000, '媒体 TTL');
        this.maxItems = bounded(options.maxItems ?? DEFAULT_MAX_ITEMS, 1, 4096, '媒体条目上限');
        this.maxItemsPerClient = bounded(options.maxItemsPerClient ?? DEFAULT_MAX_ITEMS_PER_CLIENT, 1, this.maxItems, '每设备媒体条目上限');
        this.maxTotalBytes = bounded(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 1, 512 * 1024 * 1024, '媒体总大小上限');
        this.now = options.now ?? Date.now;
        this.id = options.id ?? (() => randomBytes(18).toString('hex'));
    }

    put(input: Omit<CompanionMediaRecord, 'mediaId' | 'createdAt' | 'expiresAt'> & { now?: number }): CompanionMediaRecord {
        const now = input.now ?? this.now();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(input.clientId)) throw new Error('媒体设备标识不合法');
        if (!MIME.test(input.mime) || (!input.mime.toLowerCase().startsWith('audio/') && !input.mime.toLowerCase().startsWith('image/'))) throw new Error('只允许音频或图片媒体');
        if (!Buffer.isBuffer(input.data) || input.data.length < 1 || input.data.length > MAX_MEDIA_BYTES) throw new Error('媒体大小超出限制');
        if (input.bytes !== input.data.length) throw new Error('媒体字节数不一致');
        validateOptionalNumber(input.durationMs, 0, 2 * 60 * 60_000, '媒体时长');
        validateOptionalNumber(input.width, 1, 8192, '媒体宽度');
        validateOptionalNumber(input.height, 1, 8192, '媒体高度');
        this.purge(now);
        if (input.data.length > this.maxTotalBytes) throw new Error('媒体超过仓库总大小上限');
        this.evictFor(input.clientId, input.data.length);
        const mediaId = this.newId();
        const record: CompanionMediaRecord = {
            mediaId,
            clientId: input.clientId,
            mime: input.mime.toLowerCase(),
            bytes: input.data.length,
            data: Buffer.from(input.data),
            createdAt: now,
            expiresAt: now + this.ttlMs,
            ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            ...(input.width === undefined ? {} : { width: input.width }),
            ...(input.height === undefined ? {} : { height: input.height }),
        };
        this.records.set(mediaId, record);
        this.totalBytes += record.bytes;
        return { ...record, data: Buffer.from(record.data) };
    }

    get(clientId: string, mediaId: string, now = this.now()): CompanionMediaRecord | undefined {
        this.purge(now);
        const record = this.records.get(mediaId);
        if (!record || record.clientId !== clientId) return undefined;
        return { ...record, data: Buffer.from(record.data) };
    }

    clear(clientId?: string, now = this.now()): number {
        this.purge(now);
        let removed = 0;
        for (const [mediaId, record] of this.records) {
            if (clientId !== undefined && record.clientId !== clientId) continue;
            this.remove(mediaId);
            removed += 1;
        }
        return removed;
    }

    purge(now = this.now()): number {
        let removed = 0;
        for (const [mediaId, record] of this.records) {
            const age = now - record.createdAt;
            if (record.expiresAt <= now || age < -MAX_CLOCK_SKEW_MS) { this.remove(mediaId); removed += 1; }
        }
        return removed;
    }

    private evictFor(clientId: string, incomingBytes: number): void {
        const candidates = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
        let clientCount = candidates.filter(record => record.clientId === clientId).length;
        // 先只淘汰当前设备最旧的媒体。不能在遇到别的设备时提前停止，
        // 否则全局最旧记录属于另一台设备时会绕过每设备上限。
        for (const record of candidates) {
            if (clientCount < this.maxItemsPerClient) break;
            if (record.clientId !== clientId) continue;
            this.remove(record.mediaId);
            clientCount -= 1;
        }
        // 再按全局最旧顺序满足总条目数和总字节数上限。
        for (const record of candidates) {
            if (!this.records.has(record.mediaId)) continue;
            const overItems = this.records.size >= this.maxItems;
            const overBytes = this.totalBytes + incomingBytes > this.maxTotalBytes;
            if (!overItems && !overBytes) break;
            this.remove(record.mediaId);
        }
    }

    private remove(mediaId: string): void {
        const record = this.records.get(mediaId);
        if (!record) return;
        this.records.delete(mediaId);
        this.totalBytes -= record.bytes;
    }

    private newId(): string {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const value = this.id();
            if (/^[a-f0-9]{16,128}$/i.test(value) && !this.records.has(value)) return value;
        }
        throw new Error('媒体 ID 生成器重复返回');
    }
}

function bounded(value: number, min: number, max: number, label: string): number {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}不合法`);
    return value;
}

function validateOptionalNumber(value: number | undefined, min: number, max: number, label: string): void {
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${label}不合法`);
}
