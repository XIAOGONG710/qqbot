import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAppConfig } from '../src/platform/config.ts';
import { applyTimeZone, canonicalTimeZone, DEFAULT_TIME_ZONE, processTimeZone } from '../src/platform/time-zone.ts';

const base = {
    characterCard: 'missing-{tier}.json',
    llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
    contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }],
};
const env = { QQBOT_LLM_API_KEY: 'synthetic-key' };
const configTs = resolve(fileURLToPath(import.meta.url), '../../src/platform/config.ts');

describe('她的时区（ADR 0248）', () => {
    test('测试进程固定在默认时区，不跟机器走', () => {
        assert.equal(DEFAULT_TIME_ZONE, 'Asia/Shanghai');
        assert.equal(processTimeZone(), 'Asia/Shanghai');
        assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 0);
    });

    test('配置：不写就是上海；写了按 IANA 校验并取规范写法；不认识的拒绝', () => {
        assert.equal(parseAppConfig(base, '/repo', env).timeZone, 'Asia/Shanghai');
        assert.equal(parseAppConfig({ ...base, timeZone: 'asia/tokyo' }, '/repo', env).timeZone, 'Asia/Tokyo');
        assert.throws(() => parseAppConfig({ ...base, timeZone: 'Mars/Olympus' }, '/repo', env), /timeZone 不是认识的时区/);
        assert.throws(() => parseAppConfig({ ...base, timeZone: '' }, '/repo', env), /timeZone 应为 IANA 时区名/);
        assert.throws(() => canonicalTimeZone(8), /IANA/);
    });

    test('parseAppConfig 只解析，不改进程时区', () => {
        parseAppConfig({ ...base, timeZone: 'America/New_York' }, '/repo', env);
        assert.equal(processTimeZone(), 'Asia/Shanghai');
    });

    test('applyTimeZone 立即改变本地时间方法的结果，返回原来的 TZ', () => {
        const previous = applyTimeZone('Asia/Tokyo');
        try {
            assert.equal(previous, 'Asia/Shanghai');
            assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 1);
        } finally {
            applyTimeZone('Asia/Shanghai');
        }
        assert.equal(new Date('2026-10-12T00:10:00+08:00').getHours(), 0);
    });

    test('loadConfig：机器是东京，配置没写时区，读完配置进程就是上海', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-tz-'));
        try {
            const path = join(dir, 'config.json');
            writeFileSync(path, JSON.stringify({ ...base, onebot: { url: 'ws://127.0.0.1:1' } }));
            const code = `const { loadConfig } = await import(${JSON.stringify('file:///' + configTs.replace(/\\/g, '/'))});`
                + `const before = new Date('2026-10-12T00:10:00+08:00').getHours();`
                + `loadConfig(${JSON.stringify(dir)});`
                + `console.log(before, new Date('2026-10-12T00:10:00+08:00').getHours(), Intl.DateTimeFormat().resolvedOptions().timeZone);`;
            const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
                env: { ...process.env, TZ: 'Asia/Tokyo', QQBOT_CONFIG: path, QQBOT_LLM_API_KEY: 'synthetic-key' }, encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), '1 0 Asia/Shanghai');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
