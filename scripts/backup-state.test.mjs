import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    COMPLETE_MARKER,
    FAILURE_MARKER,
    RETRY_DELAY_MS,
    isCompleteBackup,
    nonEmptyFile,
    retryDue,
    writeBackupMarker,
} from './backup-state.mjs';

const roots = [];
const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-backup-state-'));
    roots.push(root);
    return root;
};

afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('backup completion policy', () => {
    test('an existing directory is not complete without a valid completion marker', () => {
        const target = fresh();
        assert.equal(isCompleteBackup(target), false);
        writeFileSync(join(target, COMPLETE_MARKER), '{broken', 'utf8');
        assert.equal(isCompleteBackup(target), false);
        writeBackupMarker(target, COMPLETE_MARKER, { completed: true });
        assert.equal(isCompleteBackup(target), false);
        writeFileSync(join(target, 'hindsight.sql'), 'database backup', 'utf8');
        writeFileSync(join(target, 'her-state.zip'), 'state backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: { database: { ok: true }, state: { ok: true } },
        });
        assert.equal(isCompleteBackup(target), true);
    });

    test('a completed marker is invalidated when a required artifact disappears', () => {
        const target = fresh();
        const database = join(target, 'hindsight.sql');
        const state = join(target, 'her-state.zip');
        writeFileSync(database, 'database backup', 'utf8');
        writeFileSync(state, 'state backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: { database: { ok: true }, state: { ok: true } },
        });

        assert.equal(isCompleteBackup(target), true);
        rmSync(database);
        assert.equal(isCompleteBackup(target), false);
    });

    test('a deliberately skipped empty state does not require an archive', () => {
        const target = fresh();
        writeFileSync(join(target, 'hindsight.sql'), 'database backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: { database: { ok: true }, state: { ok: true, skipped: true } },
        });

        assert.equal(isCompleteBackup(target), true);
    });

    test('an incomplete backup waits before retrying and retries after the delay', () => {
        const target = fresh();
        const attempted = Date.parse('2026-11-04T04:00:00+08:00');
        writeBackupMarker(target, FAILURE_MARKER, { attemptedAt: new Date(attempted).toISOString() });
        assert.equal(retryDue(target, attempted + RETRY_DELAY_MS - 1), false);
        assert.equal(retryDue(target, attempted + RETRY_DELAY_MS), true);
    });

    test('missing, empty and non-empty artifacts are distinguished', () => {
        const target = fresh();
        const artifact = join(target, 'hindsight.sql');
        assert.equal(nonEmptyFile(artifact), false);
        mkdirSync(artifact);
        assert.equal(nonEmptyFile(artifact), false);
        rmSync(artifact, { recursive: true });
        writeFileSync(artifact, 'backup', 'utf8');
        assert.equal(nonEmptyFile(artifact), true);
    });
});
