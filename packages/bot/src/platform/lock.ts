// 单实例锁：同一个数据目录只允许一个 bot 在跑，否则每条消息会被回复两遍。
// PID文件兼容旧诊断；真正互斥由整个运行期持有的OS租约提供，强杀后OS自动释放。

import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Persistent coordination inode: never delete or replace it while any writer runs. No domain data is stored. */
export const DATA_COORDINATION_FILE = 'bot.coordination.sqlite';

// Survive module reloads in the host's JS isolate. PID equality is not an
// ownership token: an old instance can still be draining in this process.
const leasesKey = Symbol.for('qqbot.active-data-locks');
const shared = globalThis as unknown as { [key: symbol]: Map<string, symbol> | undefined };
const leases = shared[leasesKey] ??= new Map<string, symbol>();

export type IsAlive = (pid: number) => boolean;

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM：进程存在，只是没有权限发信号
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/** 拿到锁返回释放函数；锁被一个还活着的进程持有时抛错 */
export function acquireLock(path: string, pid = process.pid, isAlive: IsAlive = isProcessAlive): () => void {
    const absolute = resolve(path);
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (pid === process.pid && leases.has(key)) throw new Error(`已有一个 bot 在运行（PID ${pid}）。本进程仍持有数据目录，请等待停止完成`);
    // PID is still diagnostic and respects an older live writer. It cannot
    // arbitrate read/unlink/create: hold an OS transaction before touching it.
    const coordinator = join(dirname(canonical), DATA_COORDINATION_FILE);
    let database: DatabaseSync | undefined, acquired = false;
    const close = () => {
        try { if (acquired) database?.exec('ROLLBACK'); }
        finally { acquired = false; database?.close(); database = undefined; }
    };
    try {
        try { if (lstatSync(coordinator).isSymbolicLink()) throw new Error('coordination link'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        database = new DatabaseSync(coordinator, { timeout: 50 });
        database.exec('BEGIN IMMEDIATE'); acquired = true;
    } catch (error) {
        try { close(); } catch { /* Acquisition already failed; do not expose provider details. */ }
        const code = (error as { errcode?: number }).errcode;
        if (typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6)) {
            const owner = readOwner(path);
            throw new Error(owner === undefined ? '已有一个 bot 在运行或维护，数据目录协调租约忙；请等停止或清理收尾'
                : `已有一个 bot 在运行（PID ${owner}）。数据目录协调租约忙，请等待停止或清理收尾`);
        }
        throw new Error('数据目录协调租约不可用；原文件保留，请停写后核实协调文件');
    }
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                writeFileSync(path, String(pid), { flag: 'wx' });
                const token = Symbol();
                if (pid === process.pid) leases.set(key, token);
                let released = false;
                return () => {
                    if (released) return;
                    released = true;
                    if (pid === process.pid && leases.get(key) !== token) { close(); return; }
                    try { if (readOwner(path) === pid) rmSync(path, { force: true }); }
                    finally {
                        if (pid === process.pid && leases.get(key) === token) leases.delete(key);
                        close();
                    }
                };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            const owner = readOwner(path);
            if (owner !== undefined && owner !== pid && isAlive(owner)) {
                throw new Error(`已有一个 bot 在运行（PID ${owner}）。确认它已经停了的话，删掉 ${path} 再启动`);
            }
            rmSync(path, { force: true });
        }
        throw new Error(`拿不到锁 ${path}`);
    } catch (error) { try { close(); } catch { /* Preserve original failure; never leave an owned transaction open. */ } throw error; }
}

function readOwner(path: string): number | undefined {
    try {
        const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}
