import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

export function isCompleteBackup(target, expectedStateSource) {
    const marker = readMarker(join(target, COMPLETE_MARKER));
    if (marker?.completed !== true) return false;

    const database = marker.components?.database;
    const state = marker.components?.state;
    if (database?.ok !== true || state?.ok !== true) return false;
    const requireRecordedSize = expectedStateSource !== undefined;
    if (!matchesArtifact(join(target, 'hindsight.sql'), database, requireRecordedSize)) return false;
    if (expectedStateSource === null) return state.skipped === true;
    if (typeof expectedStateSource === 'string' && state.source !== expectedStateSource) return false;
    return state.skipped === true || matchesArtifact(join(target, 'her-state.zip'), state, requireRecordedSize);
}

export function retryDue(target, now = Date.now(), delayMs = RETRY_DELAY_MS) {
    const attemptedAt = readMarker(join(target, FAILURE_MARKER))?.attemptedAt;
    const attempted = typeof attemptedAt === 'string' ? Date.parse(attemptedAt) : Number.NaN;
    const age = now - attempted;
    return !Number.isFinite(attempted) || age < 0 || age >= delayMs;
}

export function isReusableBackupArtifact(target, component, artifactName, expected = {}) {
    const complete = readMarker(join(target, COMPLETE_MARKER));
    const failure = readMarker(join(target, FAILURE_MARKER));
    const marker = complete?.completed === true ? complete : failure;
    const status = marker?.components?.[component];
    return status?.ok === true
        && Object.entries(expected).every(([key, value]) => status[key] === value)
        && matchesArtifact(join(target, artifactName), status, true);
}

export function discoverStateBackup(root) {
    for (const source of ['runtime/bot', 'runtime/bot-shadow']) {
        const directory = join(root, source);
        let entries;
        try {
            if (!statSync(directory).isDirectory()) continue;
            entries = readdirSync(directory, { withFileTypes: true });
        } catch {
            continue;
        }
        const items = entries
            .filter(entry => !['logs', 'secrets', 'bot.lock', 'last-prompt.json'].includes(entry.name))
            .filter(entry => !/^config(?:\.|$)/i.test(entry.name))
            .map(entry => join(directory, entry.name));
        return { source, items };
    }
    return undefined;
}

export function backupDirectoriesToPrune(names, completeNames, todayName, keepDays = 7) {
    const today = parseDay(todayName);
    if (today === undefined || !Number.isSafeInteger(keepDays) || keepDays < 1) return [];
    const dated = names
        .map(name => ({ name, day: parseDay(name) }))
        .filter(entry => entry.day !== undefined)
        .sort((left, right) => left.name.localeCompare(right.name));
    const complete = new Set(completeNames.filter(name => parseDay(name) !== undefined));
    const protectedComplete = new Set(
        dated.filter(entry => complete.has(entry.name)).slice(-keepDays).map(entry => entry.name),
    );
    const recentCutoff = today - (keepDays - 1) * 24 * 60 * 60_000;
    return dated
        .filter(entry => entry.day < recentCutoff && !protectedComplete.has(entry.name))
        .map(entry => entry.name);
}

function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = Date.UTC(year, month - 1, day);
    const date = new Date(parsed);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? parsed
        : undefined;
}

export function nonEmptyFile(path) {
    try {
        const stat = statSync(path);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

function matchesArtifact(path, status, requireRecordedSize) {
    try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size <= 0) return false;
        if (Number.isSafeInteger(status?.bytes) && status.bytes > 0) return stat.size === status.bytes;
        return !requireRecordedSize;
    } catch {
        return false;
    }
}

export function writeBackupMarker(target, name, value) {
    writeFileSync(join(target, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
