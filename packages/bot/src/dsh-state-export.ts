import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sanitizeDshState, type DshState } from './dsh-link.ts';

/** QQ → DSH 的只读状态快照版本；过期后 DSH 必须降级，不得拿旧值冒充当前状态。 */
export const DSH_STATE_EXPORT_VERSION = 1;
export const DSH_STATE_STALE_MS = 30 * 60_000;

export interface DshStateExport {
    kind: 'qq-dsh-state';
    version: typeof DSH_STATE_EXPORT_VERSION;
    generatedAt: string;
    state: DshState;
}

export function renderDshState(state: DshState, at = Date.now()): string {
    const safe = sanitizeDshState(state);
    const output: DshStateExport = {
        kind: 'qq-dsh-state',
        version: DSH_STATE_EXPORT_VERSION,
        generatedAt: new Date(at).toISOString(),
        state: {
            at: safe.at,
            ...(safe.tier ? { tier: safe.tier } : {}),
            ...(safe.needs ? { needs: { ...safe.needs } } : {}),
            ...(safe.values ? { values: { ...safe.values } } : {}),
            ...(safe.relationship ? { relationship: { ...safe.relationship } } : {}),
            ...(safe.recentEvents?.length ? { recentEvents: [...safe.recentEvents] } : {}),
        },
    };
    return `${JSON.stringify(output, null, 2)}\n`;
}

/** 原子写入，避免 DSH 读到半个 JSON。目录不存在时一并创建。 */
export function writeDshState(path: string, state: DshState, at = Date.now()): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, renderDshState(state, at), 'utf8');
    renameSync(tmp, path);
}

export function dshStateFresh(generatedAt: string, now = Date.now(), staleMs = DSH_STATE_STALE_MS): boolean {
    const at = Date.parse(generatedAt);
    return Number.isFinite(at) && at <= now + 60_000 && now - at <= staleMs;
}
