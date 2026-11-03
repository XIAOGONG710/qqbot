import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COMPLETE_MARKER = '.complete.json';
export const FAILURE_MARKER = '.last-failure.json';
export const RETRY_DELAY_MS = 30 * 60_000;

function readMarker(path) {
    if (!existsSync(path)) return undefined;
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        return value && typeof value === 'object' ? value : undefined;
    } catch {
        return undefined;
    }
}

export function isCompleteBackup(target) {
    return readMarker(join(target, COMPLETE_MARKER))?.completed === true;
}

export function retryDue(target, now = Date.now(), delayMs = RETRY_DELAY_MS) {
    const attemptedAt = readMarker(join(target, FAILURE_MARKER))?.attemptedAt;
    const attempted = typeof attemptedAt === 'string' ? Date.parse(attemptedAt) : Number.NaN;
    return !Number.isFinite(attempted) || now - attempted >= delayMs;
}

export function nonEmptyFile(path) {
    try {
        const stat = statSync(path);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

export function writeBackupMarker(target, name, value) {
    writeFileSync(join(target, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
