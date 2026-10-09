// 运行时的状态文件（记忆写入进度、主动消息的记录、换档记录）怎么读写（ADR 0013 决策 3）：
// - 写：先写到同目录的临时文件再改名，进程在写到一半时被杀（Ctrl+C 重启 Koishi）也不会留下半截的 JSON；
// - 读：读不了（半截、手改坏了）时把坏文件挪到一边（.corrupt-<时间>），用调用方给的初始值接着跑，记一行日志，
//   免得一个坏文件让每次回复都报错。

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

let writeSequence = 0;
const RETRYABLE_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);
const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function writeJsonAtomic(path: string, value: unknown): void {
    // 组件重启的交界处可能有两次写入；固定的 .tmp 会互相覆盖。
    // Windows 上杀毒软件 / 索引器也会短暂占住目标文件，让 rename 抛 EPERM：唯一临时文件加短重试后再放弃。
    const tmp = `${path}.tmp-${process.pid}-${++writeSequence}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    let failure: unknown;
    for (const delay of [0, 10, 25, 50, 100, 200]) {
        if (delay) wait(delay);
        try {
            renameSync(tmp, path);
            return;
        } catch (error) {
            failure = error;
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            if (!RETRYABLE_RENAME.has(code)) break;
        }
    }
    try { unlinkSync(tmp); } catch { /* 保留最初的写入错误 */ }
    throw failure;
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
