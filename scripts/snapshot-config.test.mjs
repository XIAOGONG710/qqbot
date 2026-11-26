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

    test('遮掉联系人 / 群 / B 站 uid 的号码和列表项里的密钥；端口、超时、开关照留（2026-11-27：仓库被发现公开，快照里带着 QQ 号）', () => {
        const source = [
            'qqbot:',
            '  contacts:',
            '    - qq: 1234567',
            '      tier: boyfriend',
            "    - qq: '7654321'",
            '  groups:',
            '    - id: 987654321',
            '    - token: list-item-secret',
            '  bilibiliAtUid: 3546789012',
            '  port: 5140',
            '  timeoutMs: 120000',
            '  dailyMax: 4',
            '  deviceControl: on',
            '',
        ].join('\n');
        const redacted = redactYamlSecrets(source);
        assert.doesNotMatch(redacted, /1234567|7654321|987654321|3546789012|list-item-secret/);
        assert.equal((redacted.match(/<号码已隐去>/g) ?? []).length, 4);
        assert.match(redacted, /- token: <已脱敏>/, '列表项里的密钥也遮');
        assert.match(redacted, /port: 5140/);
        assert.match(redacted, /timeoutMs: 120000/, '键名不以 qq / uid / id 结尾的数字不动');
        assert.match(redacted, /tier: boyfriend/);
        assert.equal(containsObviousSecret(redacted), false);
        assert.equal(containsObviousSecret('items:\n  - token: still-here'), true, '列表项里没遮的密钥也认得出');
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
