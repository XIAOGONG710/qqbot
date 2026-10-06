import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { archiveTestData } from '../src/archive.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const KOISHI = [
    'plugins:',
    '  qqbot:8apu26:',
    '    contacts:',
    '      - qq: 1001',
    '        name: 阿明',
    '        tier: boyfriend',
    '    memory:',
    '      enabled: true',
    '      bankPrefix: linmengyao-1006',
    '    prompt:',
    '      maxContext: 16384',
    '',
].join('\n');

/** 一个像 runtime/bot 的数据目录 + 实例目录 */
function setup(koishi = KOISHI) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-archive-'));
    dirs.push(root);
    const data = join(root, 'bot');
    for (const sub of ['chats/archive', 'memory/archive-old', 'proactive']) mkdirSync(join(data, sub), { recursive: true });
    writeFileSync(join(data, 'chats/1001.jsonl'), '{"time":"2026-10-05T08:00:00.000Z","role":"user","content":"在吗"}\n');
    writeFileSync(join(data, 'chats/1002.jsonl'), '{"time":"2026-10-05T08:00:00.000Z","role":"user","content":"哈喽"}\n');
    writeFileSync(join(data, 'chats/archive/1001-boyfriend-20261005-before-m5.jsonl'), '旧的\n');
    writeFileSync(join(data, 'memory/1001-boyfriend.json'), '{}\n');
    writeFileSync(join(data, 'memory/archive-old/x.json'), '{}\n');
    writeFileSync(join(data, 'proactive/1001-boyfriend.json'), '{"records":[]}\n');
    writeFileSync(join(data, 'tiers.json'), JSON.stringify({ 1001: { tier: 'boyfriend', since: '2026-10-05T06:32:02.460Z' }, 1002: 'classmate' }, null, 2));
    const koishiYml = join(root, 'koishi.yml');
    writeFileSync(koishiYml, koishi);
    const configJson = join(root, 'config.json');
    writeFileSync(configJson, JSON.stringify({ llm: { model: 'm' }, memory: { baseUrl: 'http://127.0.0.1:8888', bankPrefix: 'linmengyao-1006' } }, null, 4) + '\n');
    return { root, data, koishiYml, configJson };
}

const now = new Date(2026, 9, 6, 1, 30);

describe('测试数据归档（ADR 0014 决策 6）', () => {
    test('只挪不删：聊天记录、记忆进度、主动记录挪进 archive，tiers.json 记起点、旧的另存，两处 bank 前缀都换', () => {
        const { data, koishiYml, configJson } = setup();
        const result = archiveTestData({ dataDir: data, configFiles: [koishiYml, configJson], now, isAlive: () => false });
        assert.equal(result.stamp, '20261006-0130');
        assert.ok(existsSync(join(data, 'chats/archive/1001-boyfriend-20261006-0130.jsonl')));
        assert.ok(existsSync(join(data, 'chats/archive/1002-classmate-20261006-0130.jsonl')));
        assert.ok(existsSync(join(data, 'chats/archive/1001-boyfriend-20261005-before-m5.jsonl')), '以前归档的不动');
        assert.ok(!existsSync(join(data, 'chats/1001.jsonl')));
        assert.ok(existsSync(join(data, 'memory/archive-20261006-0130/1001-boyfriend.json')));
        assert.ok(existsSync(join(data, 'memory/archive-old/x.json')), '以前的 archive 目录不动');
        assert.ok(existsSync(join(data, 'proactive/archive-20261006-0130/1001-boyfriend.json')));
        const tiers = JSON.parse(readFileSync(join(data, 'tiers.json'), 'utf8'));
        assert.deepEqual(tiers, { 1001: { tier: 'boyfriend', since: now.toISOString() }, 1002: { tier: 'classmate', since: now.toISOString() } });
        assert.match(readFileSync(join(data, 'tiers.before-20261006-0130.json'), 'utf8'), /2026-10-05T06:32:02.460Z/);
        assert.equal(readFileSync(koishiYml, 'utf8'), KOISHI.replace('bankPrefix: linmengyao-1006', 'bankPrefix: linmengyao-10060130'));
        const config = JSON.parse(readFileSync(configJson, 'utf8'));
        assert.equal(config.memory.bankPrefix, 'linmengyao-10060130');
        assert.match(readFileSync(configJson, 'utf8'), /^\{\n {4}"llm"/, '缩进照旧');
        assert.deepEqual(result.prefix.map(p => [p.from, p.to]), [['linmengyao-1006', 'linmengyao-10060130'], ['linmengyao-1006', 'linmengyao-10060130']]);
    });
    test('--dry-run 什么都不动', () => {
        const { data, koishiYml } = setup();
        const result = archiveTestData({ dataDir: data, configFiles: [koishiYml], now, dryRun: true, isAlive: () => false });
        assert.equal(result.moves.length, 4);
        assert.ok(existsSync(join(data, 'chats/1001.jsonl')));
        assert.equal(readFileSync(koishiYml, 'utf8'), KOISHI);
        assert.ok(!existsSync(join(data, 'tiers.before-20261006-0130.json')));
    });
    test('bot 还在跑（锁的持有者活着）就不动；留下的旧锁不挡', () => {
        const { data, koishiYml } = setup();
        writeFileSync(join(data, 'bot.lock'), '4321');
        assert.throws(() => archiveTestData({ dataDir: data, configFiles: [koishiYml], now, isAlive: pid => pid === 4321 }), /还在跑.*PID 4321/);
        assert.ok(existsSync(join(data, 'chats/1001.jsonl')));
        archiveTestData({ dataDir: data, configFiles: [koishiYml], now, isAlive: () => false });
        assert.ok(!existsSync(join(data, 'chats/1001.jsonl')));
    });
    test('koishi.yml 没写前缀（用的默认值）就在 enabled 下面加一行；长期记忆没开就不改', () => {
        const noPrefix = KOISHI.replace('      bankPrefix: linmengyao-1006\n', '');
        const a = setup(noPrefix);
        archiveTestData({ dataDir: a.data, configFiles: [a.koishiYml], now, prefix: 'linmengyao-test', isAlive: () => false });
        assert.equal(readFileSync(a.koishiYml, 'utf8'), noPrefix.replace('      enabled: true\n', '      enabled: true\n      bankPrefix: linmengyao-test\n'));
        const off = KOISHI.replace('      enabled: true\n      bankPrefix: linmengyao-1006\n', '      enabled: false\n');
        const b = setup(off);
        const result = archiveTestData({ dataDir: b.data, configFiles: [b.koishiYml], now, isAlive: () => false });
        assert.equal(readFileSync(b.koishiYml, 'utf8'), off);
        assert.match(result.skipped[0]!.reason, /长期记忆没开/);
    });
    test('前缀写错、和现在一样，报错且什么都不动', () => {
        const { data, koishiYml } = setup();
        assert.throws(() => archiveTestData({ dataDir: data, configFiles: [koishiYml], now, prefix: 'lin meng', isAlive: () => false }), /只能有字母/);
        assert.throws(() => archiveTestData({ dataDir: data, configFiles: [koishiYml], now, prefix: 'linmengyao-1006', isAlive: () => false }), /和现在的一样/);
        assert.ok(existsSync(join(data, 'chats/1001.jsonl')));
    });
});
