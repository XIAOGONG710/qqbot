// 危机信号的最小记录：只记联系人、时间和风险级别，不记原话。

import { join } from 'node:path';
import type { CrisisLevel } from './crisis.ts';
import { readJsonOr, writeJsonAtomic } from '.././json-file.ts';

export const CRISIS_PAUSE_MS = 48 * 3_600_000;

interface CrisisRecord { at: string; level: CrisisLevel }
interface CrisisFile { version: 2; contacts: Record<string, CrisisRecord> }

const LEVEL_ORDER: Record<CrisisLevel, number> = { concern: 1, high: 2, imminent: 3 };
const isLevel = (value: unknown): value is CrisisLevel => value === 'concern' || value === 'high' || value === 'imminent';
const isRecord = (value: unknown): value is CrisisRecord => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'at' in value && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
    && 'level' in value && isLevel(value.level));
const isFile = (value: unknown): value is CrisisFile => Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && 'version' in value && value.version === 2
    && 'contacts' in value && value.contacts && typeof value.contacts === 'object' && !Array.isArray(value.contacts)
    && Object.entries(value.contacts).every(([qq, record]) => /^\d+$/.test(qq) && isRecord(record)));

function migrate(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value) || 'version' in value) return value;
    // v1: { "<qq>": "<ISO>" }. 旧记录没有分级，按 high 保守迁移。
    if (Object.entries(value).every(([qq, at]) => /^\d+$/.test(qq) && typeof at === 'string' && Number.isFinite(Date.parse(at)))) {
        return { version: 2, contacts: Object.fromEntries(Object.entries(value).map(([qq, at]) => [qq, { at, level: 'high' }])) };
    }
    return value;
}

export interface CrisisState {
    mark(qq: number, at: number, level: CrisisLevel): void;
    last(qq: number): { at: number; level: CrisisLevel } | undefined;
    lastAt(qq: number): number | undefined;
    pausedAt(qq: number, now: number): boolean;
}

export function createCrisisState(dataDir: string, log: (message: string) => void): CrisisState {
    const path = join(dataDir, 'crisis.json');
    const state = readJsonOr<CrisisFile>(path, { version: 2, contacts: {} }, log, {
        migrate, validate: isFile, invalid: 'throw', label: '危机状态',
    });
    return {
        mark(qq, at, level) {
            const key = String(qq);
            const earlier = state.contacts[key];
            const earlierAt = earlier ? Date.parse(earlier.at) : 0;
            if (at < earlierAt || (at === earlierAt && earlier && LEVEL_ORDER[level] <= LEVEL_ORDER[earlier.level])) return;
            state.contacts[key] = { at: new Date(at).toISOString(), level };
            writeJsonAtomic(path, state);
        },
        last(qq) {
            const record = state.contacts[String(qq)];
            return record ? { at: Date.parse(record.at), level: record.level } : undefined;
        },
        lastAt(qq) { return this.last(qq)?.at; },
        pausedAt(qq, now) {
            const at = this.lastAt(qq);
            return at !== undefined && now - at < CRISIS_PAUSE_MS;
        },
    };
}
