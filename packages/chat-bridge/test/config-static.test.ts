import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveStatic, tokenBucket } from '../src/app-server.ts';
import { parseConfig, repoRoot } from '../src/config.ts';
import { sameSecret } from '../src/onebot-server.ts';
import { tempDir } from './helpers.ts';

test('配置：环境变量盖过文件，默认只听本机', () => {
    const config = parseConfig(
        { CHAT_BRIDGE_OWNER_ID: '10001', CHAT_BRIDGE_DELIVERY: 'both' },
        JSON.stringify({ ownerId: 99, selfId: 20002, selfName: '小瑶', upstreamUrl: 'ws://127.0.0.1:3001', delivery: 'last-active', appPort: 4000 }),
    );
    assert.equal(config.ownerId, 10001);
    assert.equal(config.selfId, 20002);
    assert.equal(config.selfName, '小瑶');
    assert.equal(config.upstreamUrl, 'ws://127.0.0.1:3001');
    assert.equal(config.delivery, 'both');
    assert.equal(config.host, '127.0.0.1');
    assert.deepEqual([config.onebotPort, config.appPort], [3200, 4000]);
    assert.equal(config.dataDir, join(repoRoot, 'runtime', 'chat-bridge'));
});

test('配置：缺号码、号码相同、规则不认识、上游地址带凭据、文件里写 token 都明说', () => {
    const base = { CHAT_BRIDGE_OWNER_ID: '10001', CHAT_BRIDGE_SELF_ID: '20002' };
    assert.throws(() => parseConfig({}, undefined), /他的 QQ 号/);
    assert.throws(() => parseConfig({ CHAT_BRIDGE_OWNER_ID: '10001' }, undefined), /她的 QQ 号/);
    assert.throws(() => parseConfig({ CHAT_BRIDGE_OWNER_ID: '10001', CHAT_BRIDGE_SELF_ID: '10001' }, undefined), /同一个/);
    assert.throws(() => parseConfig({ ...base, CHAT_BRIDGE_DELIVERY: 'everywhere' }, undefined), /delivery/);
    assert.throws(() => parseConfig({ ...base, CHAT_BRIDGE_UPSTREAM: 'http://127.0.0.1:3001' }, undefined), /ws:\/\//);
    assert.throws(() => parseConfig({ ...base, CHAT_BRIDGE_UPSTREAM: 'ws://127.0.0.1:3001?access_token=secret' }, undefined), /凭据/);
    assert.throws(() => parseConfig({ ...base, CHAT_BRIDGE_APP_PORT: '70000' }, undefined), /端口/);
    assert.throws(() => parseConfig(base, '{"token":"secret"}'), /token/);
    assert.throws(() => parseConfig(base, '{ nope'), /JSON/);
    const config = parseConfig(base, undefined);
    assert.equal(config.upstreamUrl, undefined);
    assert.equal(config.delivery, 'last-active');
});

test('静态文件：只给目录里、白名单类型的普通文件', t => {
    const base = tempDir(t);
    const root = join(base, 'app');
    mkdirSync(join(root, 'assets'), { recursive: true });
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'index.html'), 'index');
    writeFileSync(join(root, 'assets', 'app.js'), 'js');
    writeFileSync(join(root, 'assets', 'types.d.ts'), 'ts');
    writeFileSync(join(root, 'test', 'x.js'), 'test');
    writeFileSync(join(root, '.secret.json'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(base, 'outside.html'), 'outside');

    assert.equal(resolveStatic(root, '/')?.type, 'text/html; charset=utf-8');
    assert.equal(resolveStatic(root, '/index.html')?.path.endsWith('index.html'), true);
    assert.equal(resolveStatic(root, '/assets/app.js')?.type, 'text/javascript; charset=utf-8');
    for (const path of [
        '/../outside.html', '/%2e%2e/outside.html', '/..%2foutside.html', '/assets/../../outside.html', '/assets/..\..\outside.html',
        '/.secret.json', '/tsconfig.json', '/test/x.js', '/assets/types.d.ts', '/assets', '/assets/', '/missing.js', '/%', '/index.html%00', 'index.html', '/C:/x.html',
    ]) {
        assert.equal(resolveStatic(root, path), undefined, path);
    }
});

test('令牌桶：用完就拒，按时间补回来', () => {
    let time = 0;
    const take = tokenBucket(3, 1, () => time);
    assert.deepEqual([take(), take(), take(), take()], [true, true, true, false]);
    time += 1000;
    assert.deepEqual([take(), take()], [true, false]);
    time += 60_000;
    assert.deepEqual([take(), take(), take(), take()], [true, true, true, false]);
});

test('凭据比较：长度不同也只是不相等', () => {
    assert.equal(sameSecret('abc', 'abc'), true);
    assert.equal(sameSecret('abc', 'abd'), false);
    assert.equal(sameSecret('', 'abc'), false);
    assert.equal(sameSecret('abc'.repeat(100), 'abc'), false);
});
