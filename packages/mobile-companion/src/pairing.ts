import { randomBytes } from 'node:crypto';
import type { PairingVerifier } from './gateway.ts';

const MAX_PENDING_PAIRINGS = 64;

export interface PairingTicket {
    clientId: string;
    pairingCode: string;
    expiresAt: number;
}

/** 进程内一次性配对码存储：不落盘，过期或成功消费后立即删除。 */
export class MemoryPairingStore implements PairingVerifier {
    private readonly entries = new Map<string, { pairingCode: string; expiresAt: number }>();
    private readonly ttlMs: number;

    constructor(ttlMs = 5 * 60_000) {
        if (!Number.isInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 24 * 60 * 60_000) {
            throw new Error('配对码 TTL 必须在 10 秒到 24 小时之间');
        }
        this.ttlMs = ttlMs;
    }

    issue(clientId: string, now = Date.now()): PairingTicket {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(clientId)) throw new Error('clientId 不合法');
        this.prune(now);
        while (this.entries.size >= MAX_PENDING_PAIRINGS) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        const pairingCode = formatCode(randomBytes(6).toString('hex').toUpperCase());
        const expiresAt = now + this.ttlMs;
        this.entries.set(clientId, { pairingCode, expiresAt });
        return { clientId, pairingCode, expiresAt };
    }

    consume(clientId: string, pairingCode: string, now: number): boolean {
        const entry = this.entries.get(clientId);
        if (!entry || now >= entry.expiresAt || entry.pairingCode !== pairingCode) {
            if (entry && now >= entry.expiresAt) this.entries.delete(clientId);
            return false;
        }
        this.entries.delete(clientId);
        return true;
    }

    revoke(clientId: string): void {
        this.entries.delete(clientId);
    }

    /** 宿主永久停止时撤销所有尚未使用的一次性凭证。 */
    clear(): void {
        this.entries.clear();
    }

    private prune(now: number): void {
        for (const [clientId, entry] of this.entries) {
            if (now >= entry.expiresAt) this.entries.delete(clientId);
        }
    }
}

function formatCode(value: string): string {
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}
