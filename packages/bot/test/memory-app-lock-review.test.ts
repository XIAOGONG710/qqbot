import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireLock } from '../src/platform/lock.ts';
import { startApp } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

function fixture(work: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-lock-'));
    try { work(dir); }
    finally {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
        assert.ok(basename(dir).startsWith('qqbot-memory-lock-'));
        rmSync(dir, { recursive: true, force: true });
    }
}
function options(dir: string) {
    const config = parseAppConfig({
        dataDir: dir, characterCard: join(dir, 'missing-{tier}.json'),
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' },
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }],
        proactive: 'off',
    }, dir, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    return { config, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 }, log() {},
        sensitive: { on: () => false, describe: () => '' }, pipeline: { generate: async () => '合成回复' } };
}

test('同一PID的活跃租约不能重入，旧release重复调用不删除新租约', () => fixture(dir => {
    const path = join(dir, 'bot.lock'); const first = acquireLock(path);
    try { assert.throws(() => acquireLock(path), /已有一个 bot 在运行/); }
    finally { first(); }
    const next = acquireLock(path);
    try { first(); assert.equal(readFileSync(path, 'utf8'), String(process.pid)); }
    finally { next(); }
}));

test('启动拒绝忙目录先于任何prompt/世界状态修改和角色卡读取', () => fixture(dir => {
    const path = join(dir, 'bot.lock'); const release = acquireLock(path);
    writeFileSync(join(dir, 'last-prompt.json'), 'SYNTHETIC_PRIVATE_PROMPT');
    try {
        assert.throws(() => startApp(options(dir)), /已有一个 bot 在运行/);
        assert.equal(readFileSync(join(dir, 'last-prompt.json'), 'utf8'), 'SYNTHETIC_PRIVATE_PROMPT');
        assert.equal(existsSync(join(dir, 'world')), false);
    } finally { release(); }
}));

test('构造失败撤销本次租约，不把数据目录永久留在本进程busy状态', () => fixture(dir => {
    assert.throws(() => startApp(options(dir)));
    const path = join(dir, 'bot.lock');
    assert.equal(existsSync(path), false);
    const release = acquireLock(path); release();
}));
