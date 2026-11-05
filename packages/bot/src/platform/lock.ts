// 单实例锁：同一个数据目录只允许一个 bot 在跑，否则每条消息会被回复两遍。
// 锁文件里是持有者的 PID；进程被强杀后留下的锁，PID 已经不在了，下次启动直接接管。

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

// Survive module reloads in the host's JS isolate. PID equality is not an
// ownership token: an old instance can still be draining in this process.
const leasesKey = Symbol.for('qqbot.active-data-locks');
const shared = globalThis as unknown as { [key: symbol]: Map<string, symbol> | undefined };
const leases = shared[leasesKey] ??= new Map<string, symbol>();

export type IsAlive = (pid: number) => boolean;

/** 心跳多新才算「还活着」：持锁进程每 30 秒写一次，超过这个时间没写就当它卡死/被复用 */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM：进程存在，只是没有权限发信号
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * 拿到锁返回释放函数；锁被一个**还活着而且心跳还在写**的进程持有时抛错。
 * 心跳为什么要有（2026-10-30）：只看 PID 会被两件事骗——进程卡死（活着但不干活）和 PID 被系统复用；
 * 只看心跳又会在刚启动、还没来得及写第一次心跳时误判，所以两个一起看。
 */
export function acquireLock(
    path: string,
    pid = process.pid,
    isAlive: IsAlive = isProcessAlive,
    heartbeat?: { path: string; staleMs?: number; now?: number },
): () => void {
    const absolute = resolve(path);
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (pid === process.pid && leases.has(key)) throw new Error(`已有一个 bot 在运行（PID ${pid}）。本进程仍持有数据目录，请等待停止完成`);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(path, String(pid), { flag: 'wx' });
            const token = Symbol();
            if (pid === process.pid) leases.set(key, token);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (pid === process.pid && leases.get(key) !== token) return;
                try { if (readOwner(path) === pid) rmSync(path, { force: true }); }
                finally { if (pid === process.pid && leases.get(key) === token) leases.delete(key); }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        const owner = readOwner(path);
        if (owner !== undefined && owner !== pid && isAlive(owner) && heartbeatFresh(heartbeat)) {
            throw new Error(`已有一个 bot 在运行（PID ${owner}）。确认它已经停了的话，删掉 ${path} 再启动`);
        }
        rmSync(path, { force: true });
    }
    throw new Error(`拿不到锁 ${path}`);
}

/** 没配心跳就只认 PID（老行为）；配了就再确认心跳还新 */
function heartbeatFresh(heartbeat?: { path: string; staleMs?: number; now?: number }): boolean {
    if (!heartbeat) return true;
    try {
        const beat = readFileSync(heartbeat.path, 'utf8').trim();
        const at = Number(beat);
        if (!Number.isFinite(at) || at <= 0) return false;
        return (heartbeat.now ?? Date.now()) - at <= (heartbeat.staleMs ?? HEARTBEAT_STALE_MS);
    } catch {
        // 文件都没有：可能是第一次启动还没写，按「没心跳」处理——但 PID 活着，那还是别抢
        return true;
    }
}

/**
 * 持锁进程调它开始/续写心跳（30 秒一次够了）。
 * lockPath 一起给的话，每次心跳顺带确认锁还在——2026-10-30 线上见到锁文件被别的启动流程删掉、
 * 进程还在跑，下一次启动就会当成没人持有、起第二个实例（每条消息回两遍）。
 */
export function startHeartbeat(path: string, intervalMs = 30_000, lockPath?: string, pid = process.pid): () => void {
    const beat = () => {
        try { writeFileSync(path, String(Date.now())); } catch { /* 写不了就算了，不影响主流程 */ }
        if (!lockPath) return;
        try {
            const owner = readOwner(lockPath);
            if (owner !== pid) writeFileSync(lockPath, String(pid));
        } catch { /* 锁文件恢复不了也不影响回复 */ }
    };
    beat();
    const timer = setInterval(beat, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

function readOwner(path: string): number | undefined {
    try {
        const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}
