// Hindsight 的 Postgres 守护（docs/hindsight.md「坏连接」）。
// 内存吃紧时某个 Postgres 连接里 PGroonga 初始化会失败（mmap / calloc 失败），这个连接以后每次查询都报
// 「pgroonga: already tried to initialize and failed」，Hindsight 的连接池却一直用它：
// 2026-10-08 00:25–02:10 线上记忆召回、写入、日记时好时坏，就是一个这样的连接（PID 14812）。
// 这里每 30 秒读一遍 Postgres 日志的新内容，报过这个错的连接直接断开，连接池下次会重连一个好的。
// 只断报过错的那几个连接，别的不碰。
//
// node scripts/hindsight-watchdog.mjs [Postgres 日志目录]（默认 runtime/hindsight/pgdata/log）
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = resolve(process.argv[2] ?? join(root, 'runtime', 'hindsight', 'pgdata', 'log'));
const port = process.env.QQBOT_HINDSIGHT_DB_PORT ?? '5433';
const EVERY_MS = 30_000;
const RECENT_MS = 5 * 60_000; // 刚启动时往回看 5 分钟
const MAX_PER_TICK = 5;
const BAD = /pgroonga: (already tried to initialize and failed|failed to (create column|open database))/;
const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? (\S+) \[(\d+)\] ERROR:/;

const say = (text) => console.log(`${new Date().toLocaleString('zh-CN', { hour12: false })} ${text}`);

function findPsql() {
    const base = join(homedir(), '.pg0', 'installation');
    for (const version of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
        const exe = join(base, version, 'bin', 'psql.exe');
        if (existsSync(exe)) return exe;
    }
    throw new Error(`找不到 pg0 的 psql.exe（${base}）`);
}

function newestLog() {
    const files = readdirSync(logDir).filter((name) => name.startsWith('postgresql-') && name.endsWith('.log'));
    if (files.length === 0) return undefined;
    return files.map((name) => join(logDir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function readFrom(file, offset) {
    const size = statSync(file).size;
    if (size <= offset) return { text: '', end: size };
    const buffer = Buffer.alloc(size - offset);
    const fd = openSync(file, 'r');
    try {
        readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
        closeSync(fd);
    }
    return { text: buffer.toString('utf8'), end: size };
}

// 日志行的时间：带 UTC 的按 UTC，别的按本机时区（pg0 起的实例写 UTC）
function lineTime(date, time, zone) {
    return Date.parse(zone === 'UTC' ? `${date}T${time}Z` : `${date}T${time}`);
}

function badPids(text, since) {
    const pids = new Set();
    for (const line of text.split(/\r?\n/)) {
        if (!BAD.test(line)) continue;
        const match = LINE.exec(line);
        if (!match) continue;
        const at = lineTime(match[1], match[2], match[3]);
        if (Number.isFinite(at) && at < since) continue;
        pids.add(Number(match[4]));
    }
    return [...pids];
}

function terminate(psql, pids) {
    const sql = `select pid from pg_stat_activity where datname = 'hindsight' and pid = any(array[${pids.join(',')}]::int[]) and pg_terminate_backend(pid)`;
    const out = execFileSync(psql, ['-h', '127.0.0.1', '-p', port, '-U', 'hindsight', '-d', 'hindsight', '-At', '-c', sql], {
        env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'hindsight' },
        encoding: 'utf8',
        timeout: 15_000,
    });
    return out.split(/\r?\n/).filter(Boolean).map(Number);
}

const psql = findPsql();
const done = new Set(); // 断过的 PID：Postgres 会复用 PID，所以只记一小时
const doneAt = new Map();
let file = newestLog();
let offset = 0;
let since = Date.now() - RECENT_MS;
say(`Hindsight 守护：看 ${logDir}，每 ${EVERY_MS / 1000} 秒一次，断开 PGroonga 初始化失败过的连接（端口 ${port}）`);

function tick() {
    try {
        const latest = newestLog();
        if (!latest) return;
        if (latest !== file) {
            file = latest;
            offset = 0;
        }
        const { text, end } = readFrom(file, offset);
        offset = end;
        const now = Date.now();
        for (const [pid, at] of doneAt) {
            if (now - at > 60 * 60_000) {
                done.delete(pid);
                doneAt.delete(pid);
            }
        }
        const pids = badPids(text, since).filter((pid) => !done.has(pid)).slice(0, MAX_PER_TICK);
        since = 0; // 之后读到的都是新写的
        if (pids.length === 0) return;
        const killed = terminate(psql, pids);
        for (const pid of pids) {
            done.add(pid);
            doneAt.set(pid, now);
        }
        say(killed.length > 0
            ? `断开了 ${killed.length} 个坏连接（PID ${killed.join('、')}），连接池会重连`
            : `日志里报错的连接（PID ${pids.join('、')}）已经不在了`);
    } catch (error) {
        say(`这次没查成：${error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)}`);
    }
}

tick();
setInterval(tick, EVERY_MS);
