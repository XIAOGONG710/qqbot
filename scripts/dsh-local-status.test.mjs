import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCAL_PORTS, localStatus, parseWatchdogStamp, tcpOpen, watchdogState } from '../dsh-plugins/dsh-qqbot-services/local-status.js';
import { heartbeatRunning, readHeartbeat, writeHeartbeat } from './watchdog-heartbeat.mjs';

const listen = server => new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const stop = server => new Promise(resolve => server.close(resolve));
/** 守护日志真实的时刻写法（services-watchdog.mjs 的 say()）：本机时区，月、日不补零 */
const realStamp = at => new Date(at).toLocaleString('zh-CN', { hour12: false });
// 一月初：不管机器在哪个时区，月份都是一位数，日期也是一位数
const JAN = Date.parse('2026-01-05T08:06:03+08:00');

test('reads the local services without spawning a child process', async () => {
    const socket = createNetServer(() => {});
    const napcatPort = await listen(socket);
    const http = createHttpServer((request, response) => {
        response.writeHead(request.url === '/health' ? 200 : 404);
        response.end('ok');
    });
    const hindsightPort = await listen(http);
    const dir = mkdtempSync(join(tmpdir(), 'local-status-'));
    mkdirSync(join(dir, 'maintenance'));
    writeHeartbeat(join(dir, 'heartbeat.json'), { pid: 4242, now: JAN - 60_000 });
    try {
        const status = await localStatus({
            ports: { napcat: napcatPort, hindsight: hindsightPort, koishi: 1 },
            hindsightUrl: `http://127.0.0.1:${hindsightPort}`,
            maintenanceDir: join(dir, 'maintenance'),
            watchdogLog: join(dir, 'watchdog.log'),
            watchdogHeartbeat: join(dir, 'heartbeat.json'),
            alive: pid => pid === 4242,
            now: () => JAN,
            timeout: 500,
        });
        assert.deepEqual([status.napcat, status.hindsight, status.koishi, status.koishiListening], [true, true, false, false]);
        assert.equal(status.maintenance, true);
        assert.equal(status.watchdog, true);
        for (const key of Object.keys(LOCAL_PORTS)) assert.equal(typeof status[key], 'boolean', key);
        assert.equal(status.ports.napcat, napcatPort);
    } finally {
        await stop(socket);
        await stop(http);
    }
});

test('an unhealthy hindsight, a stale heartbeat and a dead watchdog pid read as down', async () => {
    const http = createHttpServer((_request, response) => {
        response.writeHead(500);
        response.end('nope');
    });
    const hindsightPort = await listen(http);
    const dir = mkdtempSync(join(tmpdir(), 'local-status-'));
    writeHeartbeat(join(dir, 'heartbeat.json'), { pid: 4242, now: JAN - 30 * 60_000 });
    try {
        const status = await localStatus({
            ports: { napcat: 1, hindsight: hindsightPort, koishi: 1 },
            hindsightUrl: `http://127.0.0.1:${hindsightPort}`,
            maintenanceDir: join(dir, 'missing'),
            watchdogLog: join(dir, 'watchdog.log'),
            watchdogHeartbeat: join(dir, 'heartbeat.json'),
            alive: () => true,
            now: () => JAN,
            timeout: 500,
        });
        assert.equal(status.hindsight, false);
        assert.equal(status.watchdog, false, '心跳 30 分钟没更新');
        assert.equal(status.maintenance, false);
    } finally { await stop(http); }
    writeHeartbeat(join(dir, 'heartbeat.json'), { pid: 4242, now: JAN - 30_000 });
    assert.equal(watchdogState({ heartbeat: join(dir, 'heartbeat.json'), log: join(dir, 'none.log'), now: JAN, alive: () => false }), false,
        '心跳是新的，但写心跳的进程已经没了');
});

test('without a heartbeat, a quiet log is unknown and a fresh real-format line counts as running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-status-'));
    const log = join(dir, 'watchdog.log');
    const heartbeat = join(dir, 'no-heartbeat.json');
    // 守护真实写出的样子：月、日一位数，没有心跳行，最后一行是几个小时前的事件
    writeFileSync(log, `${realStamp(JAN - 5 * 3600_000)} 服务守护：每 60 秒查一次\n${realStamp(JAN - 3 * 3600_000)} koishi：恢复正常\n`);
    assert.match(readFileSync(log, 'utf8'), /^2026\/1\/\d /, '用的是不补零的真实格式');
    assert.equal(watchdogState({ heartbeat, log, now: JAN }), null, '安静不等于停了：说不准');
    writeFileSync(log, `${realStamp(JAN - 60_000)} napcat：恢复正常\n`, { flag: 'a' });
    assert.equal(watchdogState({ heartbeat, log, now: JAN }), true, '一分钟前还写过日志');
    assert.equal(watchdogState({ heartbeat, log: join(dir, 'missing.log'), now: JAN }), null);
});

test('watchdog stamps parse field by field, including single-digit month and day', () => {
    assert.equal(parseWatchdogStamp('2026/1/5 08:05:03 服务守护：开始'), new Date(2026, 0, 5, 8, 5, 3).getTime());
    assert.equal(parseWatchdogStamp('2026/11/26 00:20:00 备份：不健康'), new Date(2026, 10, 26, 0, 20, 0).getTime());
    assert.equal(parseWatchdogStamp(realStamp(JAN)), JAN);
    assert.equal(parseWatchdogStamp('2026/2/31 08:05:03 不存在的日期'), null);
    assert.equal(parseWatchdogStamp('2026-11-26 00:20:00 tick'), null);
    assert.equal(parseWatchdogStamp('    at stack.js:1:1'), null);
});

test('the watchdog heartbeat round-trips and a live pid with a fresh beat is running', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-status-'));
    const file = join(dir, 'heartbeat.json');
    assert.equal(writeHeartbeat(file, { now: 1_000 }), true);
    assert.deepEqual(readHeartbeat(file), { pid: process.pid, at: 1_000 });
    assert.equal(heartbeatRunning(file, 1_000 + 60_000), true, '当前进程一定活着');
    assert.equal(heartbeatRunning(join(dir, 'missing.json'), 1_000), null);
    writeFileSync(file, '{"pid":');
    assert.equal(readHeartbeat(file), null, '写了一半的文件当作没有心跳');
    assert.equal(writeHeartbeat(join(dir, 'no-such-dir', 'heartbeat.json')), false, '写不进去不抛错');
});

test('a closed port reads as down, not as an error', async () => {
    assert.equal(await tcpOpen(1, { timeout: 200 }), false);
});

test('fresh local probes win over the 30-second-old child probe; the child only fills what local cannot see (review finding 8)', async () => {
    const { mergeStatus } = await import('../dsh-plugins/dsh-qqbot-services/local-status.js');
    const local = { napcat: true, hindsight: false, koishi: true, koishiListening: true, maintenance: false, ports: { napcat: 3001 },
        net: false, koishiProcesses: 0, lastConnection: null, launchers: {}, watchdog: null, locallyChecked: true };
    const stale = { napcat: false, hindsight: true, koishi: false, koishiListening: false, maintenance: true, ports: { napcat: 1 },
        net: true, koishiProcesses: 2, lastConnection: { state: 'connected', at: 'x' }, launchers: { napcat: true }, watchdog: true };
    const merged = mergeStatus(local, stale);
    assert.deepEqual([merged.napcat, merged.hindsight, merged.koishi, merged.koishiListening, merged.maintenance], [true, false, true, true, false]);
    assert.deepEqual(merged.ports, { napcat: 3001 });
    assert.deepEqual([merged.net, merged.koishiProcesses, merged.launchers.napcat, merged.lastConnection.state], [true, 2, true, 'connected']);
    assert.equal(merged.watchdog, true, '本地说不准时用子进程从进程列表里看到的');
    assert.equal(mergeStatus({ ...local, watchdog: false }, stale).watchdog, false, '本地心跳说停了就是停了');
    assert.equal(mergeStatus(local, null), local);
});
