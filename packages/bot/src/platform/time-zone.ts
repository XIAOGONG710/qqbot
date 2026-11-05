// 她的时区（ADR 0248）：作息、饭点、日记、日界都用 Date 的本地时间方法算，「本地」就是进程的时区。
// 以前跟着机器走：机器设成东京，她就整体早一个小时。现在由配置 timeZone 决定（默认 Asia/Shanghai），
// 入口在读完配置、开始算时间之前调 applyTimeZone，把 process.env.TZ 设成它（Node 改 TZ 会立即生效）。

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** 校验 IANA 时区名，返回规范写法；不认识的抛错 */
export function canonicalTimeZone(value: unknown, where = 'timeZone'): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`配置 ${where} 应为 IANA 时区名，例如 ${JSON.stringify(DEFAULT_TIME_ZONE)}`);
    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
    } catch {
        throw new Error(`配置 ${where} 不是认识的时区：${JSON.stringify(value)}`);
    }
}

/** 进程现在用的时区 */
export function processTimeZone(): string {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * 把进程时区设成 zone。返回之前的 process.env.TZ（undefined 表示没设）。
 * 设完核对一次：Node 没有生效（例如构建不带 ICU 时区数据）就抛错，不带着错的时区跑。
 */
export function applyTimeZone(zone: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const wanted = canonicalTimeZone(zone);
    const previous = env.TZ;
    env.TZ = wanted;
    if (env === process.env) {
        const actual = processTimeZone();
        if (canonicalTimeZone(actual) !== wanted) {
            if (previous === undefined) delete env.TZ; else env.TZ = previous;
            throw new Error(`设置时区 ${wanted} 没有生效（进程仍是 ${actual}）`);
        }
    }
    return previous;
}
