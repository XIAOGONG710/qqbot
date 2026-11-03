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
    const marker = readMarker(join(target, COMPLETE_MARKER));
    if (marker?.completed !== true) return false;

    const database = marker.components?.database;
    const state = marker.components?.state;
    if (database?.ok !== true || state?.ok !== true) return false;
    if (!nonEmptyFile(join(target, 'hindsight.sql'))) return false;
    return state.skipped === true || nonEmptyFile(join(target, 'her-state.zip'));
}

export function retryDue(target, now = Date.now(), delayMs = RETRY_DELAY_MS) {
    const attemptedAt = readMarker(join(target, FAILURE_MARKER))?.attemptedAt;
    const attempted = typeof attemptedAt === 'string' ? Date.parse(attemptedAt) : Number.NaN;
    const age = now - attempted;
    return !Number.isFinite(attempted) || age < 0 || age >= delayMs;
}

export function isReusableBackupArtifact(target, component, artifactName) {
    const complete = readMarker(join(target, COMPLETE_MARKER));
    const failure = readMarker(join(target, FAILURE_MARKER));
    const marker = complete?.completed === true ? complete : failure;
    return marker?.components?.[component]?.ok === true && nonEmptyFile(join(target, artifactName));
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
