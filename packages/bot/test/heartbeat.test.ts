import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { checkHeartbeat, heartbeatPath, HEARTBEAT_STALE_MS, startHeartbeat, watchStep, type AlertSink, type Heartbeat } from '../src/platform/heartbeat.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-heartbeat-')); dirs.push(dir); return dir; };
const read = (dir: string) => JSON.parse(readFileSync(heartbeatPath(dir), 'utf8')) as Heartbeat;
const T0 = Date.parse('2026-10-15T12:00:00+08:00');

describe('心跳写入', () => {
    test('马上写一次：时间、进程号、提交、启动时间；连上 / 收到消息的时间有就带；不含聊天内容', () => {
        const dir = tmp();
        let now = T0;
        let connectedAt: Date | undefined;
        const writer = startHeartbeat({ dataDir: dir, now: () => new Date(now), pid: 4242, ref: 'abc1234', everyMs: 3_600_000, state: () => ({ connectedAt, lastMessageAt: undefined }) });
        try {
            assert.deepEqual(read(dir), { at: new Date(T0).toISOString(), pid: 4242, ref: 'abc1234', startedAt: new Date(T0).toISOString() });
            now += 60_000;
            connectedAt = new Date(now);
            writer.beat();
            assert.deepEqual(read(dir), { at: new Date(T0 + 60_000).toISOString(), pid: 4242, ref: 'abc1234', startedAt: new Date(T0).toISOString(), connectedAt: new Date(T0 + 60_000).toISOString() });
        } finally { writer.stop(); }
    });

    test('定时再写；stop 之后不再写，旧心跳文件留着', async () => {
        const dir = tmp();
        let count = 0;
        const writer = startHeartbeat({ dataDir: dir, everyMs: 15, now: () => new Date(T0 + 1000 * count++) });
        await new Promise(resolve => setTimeout(resolve, 100));
        writer.stop();
        const before = read(dir).at;
        assert.notEqual(before, new Date(T0).toISOString(), '定时器写过');
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.equal(read(dir).at, before, 'stop 之后没再写');
    });

    test('写失败只记一行日志、不抛；恢复后再失败会再记一次', () => {
        const dir = tmp();
        const missing = join(dir, 'not-there', 'deeper');
        const logs: string[] = [];
        const writer = startHeartbeat({ dataDir: missing, everyMs: 3_600_000, log: line => logs.push(line) });
        try {
            writer.beat();
            writer.beat();
            assert.equal(logs.length, 1, logs.join('|'));
            assert.match(logs[0]!, /心跳：写 heartbeat.json 失败/);
            mkdirSync(missing, { recursive: true });
            writer.beat();
            assert.equal(existsSync(heartbeatPath(missing)), true);
            rmSync(missing, { recursive: true, force: true });
            writer.beat();
            assert.equal(logs.length, 2);
        } finally { writer.stop(); }
    });
});

describe('心跳检查', () => {
    const put = (dir: string, at: number) => writeFileSync(heartbeatPath(dir), JSON.stringify({ at: new Date(at).toISOString(), pid: 1, ref: 'x', startedAt: new Date(at).toISOString() }));

    test('正常 / 过期（默认 15 分钟）/ 没有文件 / 读不了 / 维护中', () => {
        const dir = tmp();
        assert.equal(checkHeartbeat(dir, new Date(T0)).state, 'missing');
        put(dir, T0);
        assert.equal(checkHeartbeat(dir, new Date(T0 + HEARTBEAT_STALE_MS)).state, 'ok', '刚好 15 分钟还算正常');
        assert.equal(checkHeartbeat(dir, new Date(T0 + HEARTBEAT_STALE_MS + 1)).state, 'stale');
        assert.equal(checkHeartbeat(dir, new Date(T0 - 60_000)).state, 'ok', '一个心跳周期内的校时误差可接受');
        assert.equal(checkHeartbeat(dir, new Date(T0 - 60_001)).state, 'unreadable', '明显未来的心跳不能掩盖失联');
        assert.equal(checkHeartbeat(dir, new Date(T0 + 3_600_000), { maxAgeMs: 2 * 3_600_000 }).state, 'ok', '阈值可调');
        assert.equal(checkHeartbeat(dir, new Date(T0 + 3_600_000), { maintenance: true }).state, 'maintenance', '维护旗免检');
        writeFileSync(heartbeatPath(dir), 'not json');
        assert.equal(checkHeartbeat(dir, new Date(T0)).state, 'unreadable');
        writeFileSync(heartbeatPath(dir), JSON.stringify({ at: 'yesterday' }));
        assert.equal(checkHeartbeat(dir, new Date(T0)).state, 'unreadable');
    });

    test('告警状态机：故障开始报一次、持续不重复、恢复报一次；没有文件和维护中不改变状态', () => {
        const dir = tmp();
        const events: string[] = [];
        const sink: AlertSink = { raise: message => events.push(`raise:${message.slice(0, 12)}`), clear: message => events.push(`clear:${message.slice(0, 8)}`) };
        put(dir, T0);
        const verdictAt = (offset: number, options = {}) => checkHeartbeat(dir, new Date(T0 + offset), options);
        let alerting = false;
        alerting = watchStep(verdictAt(60_000), alerting, sink);
        assert.equal(alerting, false);
        alerting = watchStep(verdictAt(HEARTBEAT_STALE_MS + 1000), alerting, sink);
        alerting = watchStep(verdictAt(HEARTBEAT_STALE_MS + 61_000), alerting, sink);
        assert.equal(alerting, true);
        assert.equal(events.length, 1, '持续故障不重复报');
        alerting = watchStep(verdictAt(HEARTBEAT_STALE_MS + 61_000, { maintenance: true }), alerting, sink);
        assert.equal(alerting, true, '维护中保持原状态');
        put(dir, T0 + HEARTBEAT_STALE_MS + 90_000);
        alerting = watchStep(verdictAt(HEARTBEAT_STALE_MS + 100_000), alerting, sink);
        assert.equal(alerting, false);
        assert.equal(events.length, 2);
        assert.match(events[1]!, /^clear:/);
        assert.equal(watchStep({ state: 'missing' }, false, sink), false, '没有文件不报');
        assert.equal(events.length, 2);
        assert.equal(watchStep({ state: 'unreadable' }, false, sink), true, '读不了算故障');
        assert.equal(events.length, 3);
    });
});

describe('守望命令（--once）', () => {
    const cli = resolve(import.meta.dirname, '../src/ops/heartbeat-watch-cli.ts');
    const run = (dir: string, extra: string[] = [], env: Record<string, string> = {}) =>
        spawnSync(process.execPath, [cli, '--once', '--dir', dir, ...extra], { encoding: 'utf8', env: { ...process.env, TEMP: dir, ...env } });

    test('新鲜：退出码 0、没有 ALERT.txt；过期：退出码 1、写 ALERT.txt；又新鲜：删掉 ALERT.txt；有维护旗：不告警', () => {
        const dir = tmp();
        const write = (at: number) => writeFileSync(heartbeatPath(dir), JSON.stringify({ at: new Date(at).toISOString(), pid: 7, ref: 'x', startedAt: new Date(at).toISOString() }));
        write(Date.now());
        const fresh = run(dir);
        assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
        assert.match(fresh.stdout, /心跳：ok/);
        assert.equal(existsSync(join(dir, 'ALERT.txt')), false);
        write(Date.now() - 20 * 60_000);
        const stale = run(dir);
        assert.equal(stale.status, 1, stale.stdout + stale.stderr);
        assert.match(stale.stdout, /告警：.*20 分钟没更新/);
        assert.match(readFileSync(join(dir, 'ALERT.txt'), 'utf8'), /心跳已经 20 分钟没更新/);
        mkdirSync(join(dir, 'qqbot-maintenance'));
        const maintenance = run(dir);
        assert.match(maintenance.stdout, /心跳：maintenance/);
        assert.equal(maintenance.status, 1, '维护中保持原来的告警状态');
        rmSync(join(dir, 'qqbot-maintenance'), { recursive: true });
        write(Date.now());
        const recovered = run(dir);
        assert.equal(recovered.status, 0);
        assert.match(recovered.stdout, /恢复：/);
        assert.equal(existsSync(join(dir, 'ALERT.txt')), false);
    });

    test('告警命令：故障时运行一次，消息走环境变量；没有文件时不告警', () => {
        const dir = tmp();
        const out = join(dir, 'pushed.txt');
        const command = `"${process.execPath}" -e "require('fs').appendFileSync(process.env.PUSH_OUT, process.env.QQBOT_ALERT_MESSAGE + '\\n')"`;
        const none = run(dir, [], { QQBOT_ALERT_COMMAND: command, PUSH_OUT: out });
        assert.equal(none.status, 0);
        assert.match(none.stdout, /心跳：missing/);
        writeFileSync(heartbeatPath(dir), JSON.stringify({ at: new Date(Date.now() - 3_600_000).toISOString(), pid: 7, ref: 'x', startedAt: new Date().toISOString() }));
        const stale = run(dir, [], { QQBOT_ALERT_COMMAND: command, PUSH_OUT: out });
        assert.equal(stale.status, 1);
        const deadline = Date.now() + 3000;
        while (!existsSync(out) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        assert.match(readFileSync(out, 'utf8'), /心跳已经 60 分钟没更新/);
    });
});
