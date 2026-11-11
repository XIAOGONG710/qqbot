import type { LedgerEvent, Message, Part, UpstreamState } from '../src/types.d.ts';

export interface MockServer {
    port: number;
    url: string;
    code: string;
    partner: string;
    readonly seq: number;
    ledger: { seq: number; message?: Message; event?: LedgerEvent }[];
    say(parts: Part[], extra?: Partial<Message>): Message;
    event(event: LedgerEvent): { seq: number; event: LedgerEvent };
    setUpstream(state: UpstreamState): void;
    dropConnections(): void;
    newCode(): string;
    expireCode(): void;
    revokeAll(): void;
    close(): Promise<void>;
}

export function startMockServer(options?: {
    port?: number;
    code?: string;
    seed?: number;
    quiet?: boolean;
    replyDelayMs?: number;
    reusableCode?: boolean;
    replayCap?: number;
}): Promise<MockServer>;
