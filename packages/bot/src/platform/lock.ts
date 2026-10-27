// 单实例锁：同一个数据目录只允许一个 bot 在跑，否则每条消息会被回复两遍。
// 锁文件里是持有者的 PID；进程被强杀后留下的锁，PID 已经不在了，下次启动直接接管。

import { readFileSync, rmSync, writeFileSync } from 'node:fs';

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
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            writeFileSync(path, String(pid), { flag: 'wx' });
            return () => {
                if (readOwner(path) === pid) rmSync(path, { force: true });
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
}

function readOwner(path: string): number | undefined {
    try {
        const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}
