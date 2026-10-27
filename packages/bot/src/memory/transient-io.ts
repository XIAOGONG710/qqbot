// 暂时性的读写失败不等于「状态坏了」。
// 10-19 22:08 一个失控脚本把虚拟机内存吃光，承诺、生活安排、主动消息三处把一次暂时的读写失败当成永久失败，
// 各自「暂停到重启」，一小时里她没发任何主动消息；日志只写「处理失败」，没写原因。
// 这里把「暂时」和「坏了」分开：
// - 暂时的（句柄 / 内存不足、杀毒软件占住文件、Windows 的 UNKNOWN）：先跳过这一轮，下一轮再试；
// - 持续超过宽限期（TRANSIENT_GRACE_MS）的：按永久处理，失败关闭的原则不变；
// - 内容坏了（JSON 半截、不符合 schema）：照旧，不在这里处理。

/** 错误码里算「暂时」的。EPERM / EACCES / EBUSY 在 Windows 上常是杀毒软件或索引器短暂占住文件，但也可能是真的权限问题，所以只靠宽限期兜底 */
export const TRANSIENT_IO_CODES: ReadonlySet<string> = new Set([
    'EMFILE', 'ENFILE', 'ENOMEM', 'EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EIO', 'EINTR', 'ENOSPC', 'ETIMEDOUT', 'UNKNOWN',
]);

/** 持续失败超过这么久就不再当暂时的 */
export const TRANSIENT_GRACE_MS = 5 * 60_000;
/** 同一件事的「暂时失败」日志最多这么久记一次 */
export const TRANSIENT_LOG_EVERY_MS = 10 * 60_000;

/** 读写重试用完之后抛出：状态文件本身没有问题，只是这一次读不到 / 写不进 */
export class TransientStateError extends Error {
    readonly code: string;
    constructor(message: string, code: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TransientStateError';
        this.code = code;
    }
}

export function ioErrorCode(error: unknown): string {
    if (error instanceof TransientStateError) return error.code;
    return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
}

export function isTransientIoError(error: unknown): boolean {
    return error instanceof TransientStateError || TRANSIENT_IO_CODES.has(ioErrorCode(error));
}

/** 写进日志的原因：只写错误码或错误类型，不写 message（JSON.parse 的 message 会带出文件内容的片段） */
export function describeError(error: unknown): string {
    const code = ioErrorCode(error);
    if (code) return code;
    if (error instanceof Error) return error.name;
    return typeof error;
}

export interface TransientGate {
    /** 记一次暂时性失败：'retry' = 还在宽限期里，跳过这一轮下次再试；'give-up' = 拖太久了，按永久处理 */
    fail(key: string, at: number): 'retry' | 'give-up';
    /** 这件事好了：之前失败过返回 true（调用方可以记一行「恢复了」），否则 false */
    ok(key: string): boolean;
    /** 要不要记日志（同一件事 TRANSIENT_LOG_EVERY_MS 内只记一次） */
    shouldLog(key: string, at: number): boolean;
}

export function createTransientGate(graceMs: number = TRANSIENT_GRACE_MS): TransientGate {
    const since = new Map<string, number>();
    const logged = new Map<string, number>();
    return {
        fail(key, at) {
            const first = since.get(key) ?? at;
            since.set(key, first);
            return at - first >= graceMs ? 'give-up' : 'retry';
        },
        ok(key) {
            logged.delete(key);
            return since.delete(key);
        },
        shouldLog(key, at) {
            const last = logged.get(key);
            if (last !== undefined && at - last < TRANSIENT_LOG_EVERY_MS) return false;
            logged.set(key, at);
            return true;
        },
    };
}
