/** 名单外好友的固定保护线：防止陌生人刷消息把模型额度和回复队列耗尽。 */
export const UNLISTED_RATE_LIMIT = {
    windowMs: 10 * 60_000,
    perContact: 30,
    global: 100,
} as const;

export type RateLimitDecision = { allowed: true } | { allowed: false; scope: 'contact' | 'global'; retryAfterMs: number };

export class SlidingWindowRateLimiter {
    readonly #windowMs: number;
    readonly #perContact: number;
    readonly #globalLimit: number;
    readonly #global: number[] = [];
    readonly #contacts = new Map<number, number[]>();

    constructor(settings: { windowMs: number; perContact: number; global: number } = UNLISTED_RATE_LIMIT) {
        this.#windowMs = settings.windowMs;
        this.#perContact = settings.perContact;
        this.#globalLimit = settings.global;
    }

    take(contact: number, now = Date.now()): RateLimitDecision {
        this.#prune(this.#global, now);
        const own = this.#contacts.get(contact) ?? [];
        this.#prune(own, now);
        if (own.length >= this.#perContact) {
            this.#contacts.set(contact, own);
            return { allowed: false, scope: 'contact', retryAfterMs: this.#retryAfter(own, now) };
        }
        if (this.#global.length >= this.#globalLimit) {
            return { allowed: false, scope: 'global', retryAfterMs: this.#retryAfter(this.#global, now) };
        }
        own.push(now);
        this.#contacts.set(contact, own);
        this.#global.push(now);
        return { allowed: true };
    }

    #prune(entries: number[], now: number): void {
        const keepAfter = now - this.#windowMs;
        while (entries.length && entries[0]! <= keepAfter) entries.shift();
    }

    #retryAfter(entries: readonly number[], now: number): number {
        return Math.max(1, entries[0]! + this.#windowMs - now);
    }
}
