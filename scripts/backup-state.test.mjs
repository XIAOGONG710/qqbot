import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    COMPLETE_MARKER,
    FAILURE_MARKER,
    RETRY_DELAY_MS,
    backupDirectoriesToPrune,
    configuredDataDir,
    discoverStateBackup,
    isCompleteBackup,
    isReusableBackupArtifact,
    nonEmptyFile,
    retryDue,
    stateBackupDisposition,
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
            components: { database: { ok: true, bytes: 15 }, state: { ok: true, skipped: true } },
        });

        assert.equal(isCompleteBackup(target), true);
        assert.equal(isCompleteBackup(target, null), true);
        assert.equal(isCompleteBackup(target, 'runtime/bot'), false);
    });

    test('completion must match the currently authoritative state directory', () => {
        const target = fresh();
        writeFileSync(join(target, 'hindsight.sql'), 'database backup', 'utf8');
        writeFileSync(join(target, 'her-state.zip'), 'state backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: {
                database: { ok: true },
                state: { ok: true, source: 'runtime/bot-shadow', bytes: 12 },
            },
        });

        const marker = JSON.parse(readFileSync(join(target, COMPLETE_MARKER), 'utf8'));
        marker.components.database.bytes = 15;
        writeBackupMarker(target, COMPLETE_MARKER, marker);

        assert.equal(isCompleteBackup(target, 'runtime/bot-shadow'), true);
        assert.equal(isCompleteBackup(target, 'runtime/bot'), false);
    });

    test('an incomplete backup waits before retrying and retries after the delay', () => {
        const target = fresh();
        const attempted = Date.parse('2026-11-04T04:00:00+08:00');
        writeBackupMarker(target, FAILURE_MARKER, { attemptedAt: new Date(attempted).toISOString() });
        assert.equal(retryDue(target, attempted + RETRY_DELAY_MS - 1), false);
        assert.equal(retryDue(target, attempted + RETRY_DELAY_MS), true);
    });

    test('a future failure marker does not suppress retries after the clock moves back', () => {
        const target = fresh();
        const now = Date.parse('2026-11-04T04:00:00+08:00');
        writeBackupMarker(target, FAILURE_MARKER, {
            attemptedAt: new Date(now + 24 * 60 * 60_000).toISOString(),
        });

        assert.equal(retryDue(target, now), true);
    });

    test('a partial artifact is reused only after a marker records that component as successful', () => {
        const target = fresh();
        writeFileSync(join(target, 'hindsight.sql'), 'possibly partial backup', 'utf8');

        assert.equal(isReusableBackupArtifact(target, 'database', 'hindsight.sql'), false);
        writeBackupMarker(target, FAILURE_MARKER, {
            completed: false,
            components: { database: { ok: false }, state: { ok: true } },
        });
        assert.equal(isReusableBackupArtifact(target, 'database', 'hindsight.sql'), false);

        writeBackupMarker(target, FAILURE_MARKER, {
            completed: false,
            components: { database: { ok: true, bytes: 23 }, state: { ok: false } },
        });
        assert.equal(isReusableBackupArtifact(target, 'database', 'hindsight.sql'), true);
    });

    test('recorded artifact sizes detect a non-empty file that was truncated later', () => {
        const target = fresh();
        writeFileSync(join(target, 'hindsight.sql'), 'database backup', 'utf8');
        writeFileSync(join(target, 'her-state.zip'), 'state backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: {
                database: { ok: true, bytes: 15 },
                state: { ok: true, source: 'runtime/bot', bytes: 12 },
            },
        });
        assert.equal(isCompleteBackup(target, 'runtime/bot'), true);

        writeFileSync(join(target, 'her-state.zip'), 'partial', 'utf8');
        assert.equal(isCompleteBackup(target, 'runtime/bot'), false);
        assert.equal(isReusableBackupArtifact(
            target,
            'state',
            'her-state.zip',
            { source: 'runtime/bot' },
        ), false);
    });

    test('state backup discovers the active data directory and excludes credentials and transient files', () => {
        const root = fresh();
        const shadow = join(root, 'runtime', 'bot-shadow');
        mkdirSync(join(shadow, 'chats'), { recursive: true });
        mkdirSync(join(shadow, 'secrets'));
        mkdirSync(join(shadow, 'logs'));
        writeFileSync(join(shadow, 'config.json'), '{}', 'utf8');
        writeFileSync(join(shadow, 'bot.lock'), '1', 'utf8');
        assert.deepEqual(discoverStateBackup(root), {
            source: 'runtime/bot-shadow',
            items: [join(shadow, 'chats')],
        });

        const active = join(root, 'runtime', 'bot');
        mkdirSync(join(active, 'world'), { recursive: true });
        assert.deepEqual(discoverStateBackup(root), {
            source: 'runtime/bot',
            items: [join(active, 'world')],
        });
    });

    test('state backup includes complete AI photo draft and reference directories for index and file recovery', () => {
        const root = fresh();
        const active = join(root, 'runtime', 'bot');
        const drafts = join(active, 'ai-photo-drafts');
        mkdirSync(join(drafts, 'files'), { recursive: true });
        writeFileSync(join(drafts, 'index.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');
        writeFileSync(join(drafts, 'files', '111111111111.jpg'), 'image', 'utf8');
        const references = join(active, 'ai-photo-references');
        mkdirSync(join(references, 'files'), { recursive: true });
        writeFileSync(join(references, 'index.json'), JSON.stringify({ version: 1, entries: [] }), 'utf8');
        writeFileSync(join(references, 'files', '222222222222.png'), 'reference', 'utf8');

        const plan = discoverStateBackup(root);
        assert.ok(plan.items.includes(drafts));
        assert.ok(plan.items.includes(references));
        assert.equal(plan.items.some(item => item.endsWith('index.json')), false, '整目录入归档，恢复时不会漏掉 files');
    });

    test('an existing but empty state directory is a failure, not a successful skipped backup', () => {
        const root = fresh();
        const active = join(root, 'runtime', 'bot');
        mkdirSync(active, { recursive: true });
        const plan = discoverStateBackup(root);

        assert.deepEqual(plan, { source: 'runtime/bot', items: [] });
        assert.equal(stateBackupDisposition(plan), 'empty');
        assert.equal(stateBackupDisposition(undefined), 'missing');
        assert.equal(stateBackupDisposition({ source: 'runtime/bot', items: [join(active, 'chats')] }), 'ready');

        const target = fresh();
        writeFileSync(join(target, 'hindsight.sql'), 'database backup', 'utf8');
        writeBackupMarker(target, COMPLETE_MARKER, {
            completed: true,
            components: {
                database: { ok: true, bytes: 15 },
                state: { ok: true, skipped: true, source: 'runtime/bot' },
            },
        });
        assert.equal(isCompleteBackup(target, 'runtime/bot'), false);
    });

    test('an invalid authoritative state path fails closed instead of falling back or looking missing', () => {
        const root = fresh();
        mkdirSync(join(root, 'runtime'), { recursive: true });
        writeFileSync(join(root, 'runtime', 'bot'), 'not a directory', 'utf8');
        mkdirSync(join(root, 'runtime', 'bot-shadow', 'chats'), { recursive: true });

        const plan = discoverStateBackup(root);
        assert.deepEqual(plan, { source: 'runtime/bot', items: [], invalid: true });
        assert.equal(stateBackupDisposition(plan), 'invalid');
    });

    test('state archives are not reused after the authoritative data directory changes', () => {
        const target = fresh();
        writeFileSync(join(target, 'her-state.zip'), 'state backup', 'utf8');
        writeBackupMarker(target, FAILURE_MARKER, {
            completed: false,
            components: { state: { ok: true, source: 'runtime/bot-shadow', bytes: 12 } },
        });

        assert.equal(isReusableBackupArtifact(
            target,
            'state',
            'her-state.zip',
            { source: 'runtime/bot' },
        ), false);
    });

    test('retention removes stale incomplete directories but preserves recent days and recovery points', () => {
        const names = [
            '2026-09-30',
            '2026-10-01',
            '2026-10-02',
            '2026-10-28',
            '2026-10-29',
            '2026-11-03',
            '2026-11-04',
            '2026-99-99',
            'notes',
        ];
        assert.deepEqual(backupDirectoriesToPrune(
            names,
            ['2026-09-30', '2026-10-01'],
            '2026-11-04',
            1,
        ), ['2026-09-30', '2026-10-02', '2026-10-28', '2026-10-29', '2026-11-03']);

        assert.deepEqual(backupDirectoriesToPrune(
            names,
            ['2026-09-30', '2026-10-01'],
            '2026-11-04',
            7,
        ), ['2026-10-02', '2026-10-28']);
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

describe('state backup follows the configured data directory', () => {
    const koishi = (root, dataDir) => {
        mkdirSync(join(root, 'runtime', 'koishi'), { recursive: true });
        writeFileSync(join(root, 'runtime', 'koishi', 'koishi.yml'), [
            'plugins:',
            '  adapter-onebot:',
            '    endpoint: ws://127.0.0.1:3001',
            '  qqbot:abc123:',
            '    contacts: []',
            ...(dataDir ? [`    dataDir: ${dataDir}`] : []),
            '',
        ].join('\n'), 'utf8');
    };

    test('11-10..11-13: a stale runtime/bot with leftovers no longer shadows the configured runtime/bot-shadow', () => {
        const root = fresh();
        const stale = join(root, 'runtime', 'bot');
        mkdirSync(join(stale, 'secrets'), { recursive: true });
        writeFileSync(join(stale, 'ALERT.txt'), 'old', 'utf8');
        const shadow = join(root, 'runtime', 'bot-shadow');
        mkdirSync(join(shadow, 'chats'), { recursive: true });
        koishi(root, 'runtime/bot-shadow');

        assert.equal(configuredDataDir(root), 'runtime/bot-shadow');
        assert.deepEqual(discoverStateBackup(root, configuredDataDir(root)), { source: 'runtime/bot-shadow', items: [join(shadow, 'chats')] });
        // 不看配置时就是当时那个错：认成了旧目录
        assert.equal(discoverStateBackup(root).source, 'runtime/bot');
    });

    test('a configured directory that does not exist fails closed instead of a database-only success', () => {
        const root = fresh();
        koishi(root, 'runtime/bot-shadow');
        const plan = discoverStateBackup(root, configuredDataDir(root));
        assert.deepEqual(plan, { source: 'runtime/bot-shadow', items: [], invalid: true });
        assert.equal(stateBackupDisposition(plan), 'invalid');
    });

    test('no koishi.yml, no dataDir, or an absolute path inside the repo', () => {
        const root = fresh();
        assert.equal(configuredDataDir(root), undefined);
        koishi(root);
        assert.equal(configuredDataDir(root), undefined);
        koishi(root, JSON.stringify(join(root, 'runtime', 'bot-shadow')));
        assert.equal(configuredDataDir(root), 'runtime/bot-shadow');
    });
});
