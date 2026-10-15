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

export interface JsonReadOptions<T> {
    /** Parse old versions before validation. The migrated value is persisted by the caller's next normal write. */
    migrate?: (value: unknown) => unknown;
    /** Runtime schema check. Parsing valid JSON is not enough for durable state. */
    validate?: (value: unknown) => value is T;
    /** Critical state must fail closed instead of silently restarting from an empty value. */
    invalid?: 'quarantine' | 'throw';
    label?: string;
}

function invalidState(path: string, error: unknown, fallback: unknown, log: ((message: string) => void) | undefined, mode: 'quarantine' | 'throw', label: string): unknown {
    const detail = error instanceof Error ? error.message : String(error);
    if (mode === 'throw') throw new Error(`${label} ${path} 无效（${detail}），为避免把真实状态当成空白，拒绝启动；请修复、迁移或明确删除后再启动`);
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch { /* 挪不动也照样用初始值，下次写的时候会覆盖 */ }
    log?.(`${label} ${path} 读不了（${detail}），挪到 ${aside}，从头开始`);
    return fallback;
}

/** 读 JSON；可迁移并做运行时 schema 校验。非关键状态损坏时隔离，关键状态可选择失败关闭。 */
export function readJsonOr<T>(path: string, fallback: T, log?: (message: string) => void, options: JsonReadOptions<T> = {}): T {
    if (!existsSync(path)) return fallback;
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const value = options.migrate ? options.migrate(parsed) : parsed;
        if (options.validate && !options.validate(value)) throw new Error('内容不符合当前 schema');
        return value as T;
    } catch (error) {
        return invalidState(path, error, fallback, log, options.invalid ?? 'quarantine', options.label ?? '状态文件') as T;
    }
}
