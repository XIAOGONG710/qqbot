export const DOWNLINK_NONCE_TTL_MS: number;
export const DOWNLINK_NONCE_LIMIT: number;
export function rememberDownlinkNonce(nonces: Map<string, number>, value: string, acceptedAt: number): void;
