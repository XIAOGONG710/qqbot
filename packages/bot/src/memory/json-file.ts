// 运行时的状态文件（记忆写入进度、主动消息的记录、换档记录）怎么读写（ADR 0013 决策 3）：
// - 写：先写到同目录的临时文件再改名，进程在写到一半时被杀（Ctrl+C 重启 Koishi）也不会留下半截的 JSON；
// - 读：读不了（半截、手改坏了）时把坏文件挪到一边（.corrupt-<时间>），用调用方给的初始值接着跑，记一行日志，
//   免得一个坏文件让每次回复都报错。
// - 暂时读不到 / 写不进（句柄或内存不足、杀毒软件占住文件）不等于坏了：先短重试，还不行就抛 TransientStateError
//   （transient-io.ts），由调用方决定跳过这一轮；绝不把它当成「文件不存在」或「文件坏了」去覆盖 / 隔离真实状态。

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { ioErrorCode, isTransientIoError, TRANSIENT_IO_CODES, TransientStateError } from './transient-io.ts';

let writeSequence = 0;
const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 文件操作和重试间隔放在一个对象里，测试里可以换成会失败的版本 */
export const fileOps = {
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    /** 写失败（暂时性）时每次重试前等多久，毫秒；总共约 1.9 秒 */
    writeDelaysMs: [0, 10, 25, 50, 100, 200, 500, 1000] as number[],
    /** 读失败（暂时性）时每次重试前等多久，毫秒；总共约 1.6 秒 */
    readDelaysMs: [0, 50, 150, 400, 1000] as number[],
};

export function writeJsonAtomic(path: string, value: unknown): void {
    // 组件重启的交界处可能有两次写入；固定的 .tmp 会互相覆盖。
    // Windows 上杀毒软件 / 索引器会短暂占住目标文件让 rename 抛 EPERM，内存紧张时 write 会抛 EMFILE / ENOMEM / UNKNOWN：
    // 唯一临时文件加短重试后再放弃；放弃时抛 TransientStateError，别的错误（目录不存在、数据不能序列化）照旧直接抛。
    const serialized = JSON.stringify(value, null, 2);
    // JSON.stringify 对 undefined / 函数 / Symbol 根值返回 undefined 而不是抛错；
    // 若直接拼接会把文本 "undefined" 原子替换成正式状态文件，直到下次启动才暴露损坏。
    if (serialized === undefined) throw new TypeError('状态值不能序列化为 JSON');
    const text = `${serialized}\n`;
    const tmp = `${path}.tmp-${process.pid}-${++writeSequence}`;
    let failure: unknown;
    for (const delay of fileOps.writeDelaysMs) {
        if (delay) wait(delay);
        try {
            fileOps.writeFileSync(tmp, text);
            fileOps.renameSync(tmp, path);
            return;
        } catch (error) {
            failure = error;
            if (!isTransientIoError(error)) break;
        }
    }
    try { fileOps.unlinkSync(tmp); } catch { /* 保留最初的写入错误 */ }
    if (isTransientIoError(failure)) throw new TransientStateError(`${path} 暂时写不进（${ioErrorCode(failure)}）`, ioErrorCode(failure), { cause: failure });
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
    // JSON.parse及迁移器的message可能带出文件正文。保留诊断类别，不复制原文。
    const detail = `JSON/schema 解析或校验失败（${error instanceof SyntaxError ? 'SyntaxError' : 'Error'}）`;
    if (mode === 'throw') throw new Error(`${label} ${path} 无效（${detail}），为避免把真实状态当成空白，拒绝启动；请修复、迁移或明确删除后再启动`);
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch { /* 挪不动也照样用初始值，下次写的时候会覆盖 */ }
    log?.(`${label} ${path} 读不了（${detail}），挪到 ${aside}，从头开始`);
    return fallback;
}

/**
 * 读 JSON；可迁移并做运行时 schema 校验。非关键状态损坏时隔离，关键状态可选择失败关闭。
 * 文件不存在用初始值；暂时读不到（句柄 / 内存不足等）短重试后抛 TransientStateError，不隔离、不当成空白。
 */
export function readJsonOr<T>(path: string, fallback: T, log?: (message: string) => void, options: JsonReadOptions<T> = {}): T {
    const mode = options.invalid ?? 'quarantine';
    const label = options.label ?? '状态文件';
    let text: string | undefined;
    let failure: unknown;
    for (const delay of fileOps.readDelaysMs) {
        if (delay) wait(delay);
        try {
            text = fileOps.readFileSync(path, 'utf8');
            break;
        } catch (error) {
            const code = ioErrorCode(error);
            // existsSync 遇到任何错误都说「不在」，会让一次暂时的读失败变成「没有状态」再被下一次写覆盖；这里只认真正的不存在
            if (code === 'ENOENT' || code === 'ENOTDIR') return fallback;
            if (!TRANSIENT_IO_CODES.has(code)) return invalidState(path, error, fallback, log, mode, label) as T;
            failure = error;
        }
    }
    if (text === undefined) throw new TransientStateError(`${path} 暂时读不到（${ioErrorCode(failure)}）`, ioErrorCode(failure), { cause: failure });
    try {
        const parsed: unknown = JSON.parse(text);
        const value = options.migrate ? options.migrate(parsed) : parsed;
        if (options.validate && !options.validate(value)) throw new Error('内容不符合当前 schema');
        return value as T;
    } catch (error) {
        return invalidState(path, error, fallback, log, mode, label) as T;
    }
}
