import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PairingVerifier } from './gateway.ts';
import { MAX_CLOCK_SKEW_MS } from './protocol.ts';

const MAX_PENDING_PAIRINGS = 64;
/** 同一张配对码连错这么多次就作废，要回 QQ 重新生成（与 chat-bridge 一致）。 */
export const PAIRING_MAX_WRONG = 5;

export interface PairingTicket {
    clientId: string;
    pairingCode: string;
    expiresAt: number;
}

/** 进程内一次性配对码存储：不落盘，过期或成功消费后立即删除。 */
export class MemoryPairingStore implements PairingVerifier {
    private readonly entries = new Map<string, { pairingCode: string; issuedAt: number; expiresAt: number; wrong: number }>();
    private readonly ttlMs: number;
    private stopped = false;

    constructor(ttlMs = 5 * 60_000) {
        if (!Number.isInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 24 * 60 * 60_000) {
            throw new Error('配对码 TTL 必须在 10 秒到 24 小时之间');
        }
        this.ttlMs = ttlMs;
    }

    issue(clientId: string, now = Date.now()): PairingTicket {
        if (this.stopped) throw new Error('配对存储已经停止');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(clientId)) throw new Error('clientId 不合法');
        this.prune(now);
        while (this.entries.size >= MAX_PENDING_PAIRINGS) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        const pairingCode = formatCode(randomBytes(6).toString('hex').toUpperCase());
        const expiresAt = now + this.ttlMs;
        this.entries.set(clientId, { pairingCode, issuedAt: now, expiresAt, wrong: 0 });
        return { clientId, pairingCode, expiresAt };
    }

    consume(clientId: string, pairingCode: string, now: number): boolean {
        if (this.stopped) return false;
        const entry = this.entries.get(clientId);
        if (!entry) return false;
        if (entryExpired(entry, now)) {
            this.entries.delete(clientId);
            return false;
        }
        if (!sameCode(entry.pairingCode, pairingCode)) {
            entry.wrong += 1;
            if (entry.wrong >= PAIRING_MAX_WRONG) this.entries.delete(clientId);
            return false;
        }
        this.entries.delete(clientId);
        return true;
    }

    revoke(clientId: string): void {
        this.entries.delete(clientId);
    }

    /** 宿主解除配对、关闭伴侣或永久停止时撤销全部尚未使用的票据。 */
    clear(): number {
        const removed = this.entries.size;
        this.entries.clear();
        return removed;
    }

    /** 永久撤销待使用凭证，并拒绝旧集成对象再签发。 */
    stop(): void {
        this.stopped = true;
        this.clear();
    }

    private prune(now: number): void {
        for (const [clientId, entry] of this.entries) {
            if (entryExpired(entry, now)) this.entries.delete(clientId);
        }
    }
}

function entryExpired(entry: { issuedAt: number; expiresAt: number }, now: number): boolean {
    return now >= entry.expiresAt || now - entry.issuedAt < -MAX_CLOCK_SKEW_MS;
}

/** 恒定时间比较：先各自做摘要，长度不同也不提前退出。 */
function sameCode(expected: string, offered: string): boolean {
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
    return timingSafeEqual(digest(expected), digest(offered));
}

function formatCode(value: string): string {
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}
