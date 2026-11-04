import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { containsObviousSecret, redactYamlSecrets, runSnapshotConfig, snapshotStamp } from './snapshot-config.mjs';

const roots = [];
afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Koishi config snapshot', () => {
    test('redacts quoted, spaced and common credential fields without changing ordinary settings', () => {
        const source = [
            'qqbot:',
            '  enabled: true',
            '  apiKey: "sk-secret value with spaces"',
            "  'access_token': 'token value'",
            '  client-secret: very-secret',
            '  authorization: Bearer abcdefghijklmnop',
            '  cookie: "SESSDATA=private value"',
            '  model: deepseek-chat',
            '',
        ].join('\n');
        const redacted = redactYamlSecrets(source);

        assert.equal(redacted.includes('sk-secret'), false);
        assert.equal(redacted.includes('SESSDATA'), false);
        assert.equal((redacted.match(/<已脱敏>/g) ?? []).length, 5);
        assert.match(redacted, /enabled: true/);
        assert.match(redacted, /model: deepseek-chat/);
        assert.equal(containsObviousSecret(redacted), false);
    });

    test('refuses residual obvious credentials and writes a unique non-overwriting snapshot', () => {
        assert.equal(containsObviousSecret('endpoint: https://example.test\nnote: sk-abcdefghijklmnop'), true);
        assert.equal(snapshotStamp(new Date(2026, 10, 4, 10, 8, 9)), '2026-11-04-100809');

        const root = mkdtempSync(join(tmpdir(), 'qqbot-snapshot-')); roots.push(root);
        const source = join(root, 'runtime', 'koishi.yml');
        const target = join(root, 'exchange', 'snapshot.yaml');
        mkdirSync(join(root, 'runtime'), { recursive: true });
        writeFileSync(source, 'token: "private token"\nenabled: true\n', 'utf8');

        assert.equal(runSnapshotConfig({ source, target }), target);
        assert.equal(readFileSync(target, 'utf8'), 'token: <已脱敏>\nenabled: true\n');
        assert.throws(() => runSnapshotConfig({ source, target }), /EEXIST/);
        assert.throws(() => runSnapshotConfig({ source, target: source }), /不能覆盖源配置/);
    });
});
