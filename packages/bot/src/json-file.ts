// 运行时的状态文件（记忆写入进度、主动消息的记录、换档记录）怎么读写（ADR 0013 决策 3）：
// - 写：先写到同目录的临时文件再改名，进程在写到一半时被杀（Ctrl+C 重启 Koishi）也不会留下半截的 JSON；
// - 读：读不了（半截、手改坏了）时把坏文件挪到一边（.corrupt-<时间>），用调用方给的初始值接着跑，记一行日志，
//   免得一个坏文件让每次回复都报错。

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function writeJsonAtomic(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, path);
}

/** 读 JSON；没有文件返回 fallback；读坏了挪开、记日志、返回 fallback */
export function readJsonOr<T>(path: string, fallback: T, log?: (message: string) => void): T {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (error) {
        const aside = `${path}.corrupt-${Date.now()}`;
        try {
            renameSync(path, aside);
        } catch {
            // 挪不动也照样用初始值，下次写的时候会覆盖
        }
        log?.(`状态文件 ${path} 读不了（${error instanceof Error ? error.message : String(error)}），挪到 ${aside}，从头开始`);
        return fallback;
    }
}
