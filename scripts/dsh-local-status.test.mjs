import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOCAL_PORTS, localStatus, tcpOpen, watchdogRunning } from '../dsh-plugins/dsh-qqbot-services/local-status.js';

const listen = server => new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const stop = server => new Promise(resolve => server.close(resolve));
/** 守护日志那种不带时区的时刻（按本机时区写，读的时候也按本机时区） */
const localStamp = at => {
    const d = new Date(at), two = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

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
    // 守护日志的时刻没写时区、按本机时区读：从同一个「现在」按本机时区写出来。
    // 原来写死 00:20 配 +08:00 的「现在」，在不是东八区的机器上差出几十分钟，守护被当成停了。
    const now = Date.parse('2026-11-26T00:21:00+08:00');
    writeFileSync(join(dir, 'watchdog.log'), `${localStamp(now - 60_000)} tick\n`);
    try {
        const status = await localStatus({
            ports: { napcat: napcatPort, hindsight: hindsightPort, koishi: 1 },
            hindsightUrl: `http://127.0.0.1:${hindsightPort}`,
            maintenanceDir: join(dir, 'maintenance'),
            watchdogLog: join(dir, 'watchdog.log'),
            now: () => now,
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

test('an unhealthy hindsight and a stale watchdog both read as down', async () => {
    const http = createHttpServer((_request, response) => {
        response.writeHead(500);
        response.end('nope');
    });
    const hindsightPort = await listen(http);
    const dir = mkdtempSync(join(tmpdir(), 'local-status-'));
    const now = Date.parse('2026-11-26T00:30:00+08:00');
    writeFileSync(join(dir, 'watchdog.log'), `${localStamp(now - 30 * 60_000)} tick\n`);
    try {
        const status = await localStatus({
            ports: { napcat: 1, hindsight: hindsightPort, koishi: 1 },
            hindsightUrl: `http://127.0.0.1:${hindsightPort}`,
            maintenanceDir: join(dir, 'missing'),
            watchdogLog: join(dir, 'watchdog.log'),
            now: () => now,
            timeout: 500,
        });
        assert.equal(status.hindsight, false);
        assert.equal(status.watchdog, false);
        assert.equal(status.maintenance, false);
    } finally { await stop(http); }
});

test('a closed port and a missing log read as down, not as errors', async () => {
    assert.equal(await tcpOpen(1, { timeout: 200 }), false);
    assert.equal(watchdogRunning(join(tmpdir(), 'no-such-watchdog.log'), Date.now()), false);
});
