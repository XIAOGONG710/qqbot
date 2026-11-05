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
    const base = captureTimeZone(env);
    env.TZ = wanted;
    if (env === process.env) {
        const actual = processTimeZone();
        if (canonicalTimeZone(actual) !== wanted) {
            restoreTimeZone(base, env);
            throw new Error(`设置时区 ${wanted} 没有生效（进程仍是 ${actual}）`);
        }
    }
    return previous;
}

/**
 * 改时区之前的状态：env.TZ 原来的值，和进程当时实际在用的时区名。
 * 两个都要记：Windows 上的 Node，`delete process.env.TZ` 并不会让进程回到系统时区（只会停在最后一次设的那个），
 * 只有把一个时区名「赋值」回去才会变。所以 TZ 原本没设时，要靠「当时实际在用的名字」赋回去。
 */
export interface TimeZoneBase {
    previous: string | undefined;
    effective: string | undefined;
}

export function captureTimeZone(env: NodeJS.ProcessEnv = process.env): TimeZoneBase {
    // 非真实进程的 env（测试用的假对象）没有「实际在用」这回事
    return { previous: env.TZ, effective: env === process.env ? processTimeZone() : undefined };
}

/** 还原到 captureTimeZone 记下的状态：原来设过 TZ 就赋回原值；没设过就赋回当时实际在用的名字（delete 在 Windows 上不管用） */
export function restoreTimeZone(base: TimeZoneBase, env: NodeJS.ProcessEnv = process.env): void {
    const name = base.previous ?? base.effective;
    if (name === undefined) delete env.TZ; else env.TZ = name;
}

/** 常用时区，排在选择列表最前面（其余按 UTC 偏移、名字排） */
export const COMMON_TIME_ZONES = [
    'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Bangkok',
    'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Moscow', 'America/New_York', 'America/Chicago',
    'America/Denver', 'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland', 'UTC',
] as const;

export interface TimeZoneChoice {
    /** IANA 名，配置里存的就是它 */
    zone: string;
    /** 此刻相对 UTC 的偏移（分钟，夏令时算进去） */
    offsetMinutes: number;
    /** 下拉里显示的文字：IANA 名（中文名，UTC±hh:mm） */
    label: string;
}

/** 「UTC+08:00」「UTC-03:30」「UTC±00:00」 */
export function formatOffset(minutes: number): string {
    if (!minutes) return 'UTC±00:00';
    const abs = Math.abs(minutes);
    return `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function offsetMinutesAt(zone: string, now: Date): number {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
    if (!match || !match[1]) return 0;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function chineseName(zone: string, now: Date): string {
    const name = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, timeZoneName: 'long' }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? '';
    // 没有中文名的时区 ICU 会退回「GMT+8」这种写法，和后面的 UTC 偏移重复，不显示
    return /^(GMT|UTC)/.test(name) ? '' : name;
}

/**
 * 给控制台下拉用的全部时区：常用的在前，其余是 Node 自带的 IANA 列表，按此刻的 UTC 偏移、名字排。
 * 偏移是调用时的（夏令时算进去），不是全年固定值；选定后存的只是 IANA 名，夏令时由系统自己换。
 *
 * V8 的列表用的是旧规范名（Asia/Calcutta、Europe/Kiev……），Asia/Kolkata、UTC 这些常用的现代名反而不在里面，
 * 所以常用的无条件放进来；别名和它的规范名只留一项（按规范名去重），常用的那个优先。
 */
export function timeZoneChoices(now = new Date()): TimeZoneChoice[] {
    const canonical = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    const make = (zone: string): TimeZoneChoice => {
        const offsetMinutes = offsetMinutesAt(zone, now), name = chineseName(zone, now);
        return { zone, offsetMinutes, label: `${zone}（${name ? `${name}，` : ''}${formatOffset(offsetMinutes)}）` };
    };
    const seen = new Set<string>();
    const common = COMMON_TIME_ZONES.filter(zone => { const key = canonical(zone); if (seen.has(key)) return false; seen.add(key); return true; }).map(make);
    const rest = [...new Set(Intl.supportedValuesOf('timeZone'))].filter(zone => { const key = canonical(zone); if (seen.has(key)) return false; seen.add(key); return true; }).map(make)
        .sort((x, y) => x.offsetMinutes - y.offsetMinutes || x.zone.localeCompare(y.zone));
    return [...common, ...rest];
}

let claimSerial = 0;
let claimBase: TimeZoneBase | undefined;

/**
 * 占用进程时区（Koishi 插件用）：设成 zone，返回「释放」函数。
 * 插件重载是「旧实例 dispose、新实例 apply」，旧实例的收尾可能在新实例设完时区之后才结束：
 * 释放时只有「没有更新的实例占用过」才还原，不然会把新实例刚设的时区冲掉。
 * 还原到的是第一个实例占用之前的状态（不是上一个实例的），所以连续重载、改了几次时区也能回到系统默认。
 */
export function claimTimeZone(zone: string, env: NodeJS.ProcessEnv = process.env): () => void {
    const base = captureTimeZone(env);
    applyTimeZone(zone, env);
    claimBase ??= base;
    const mine = ++claimSerial;
    return () => {
        if (claimSerial !== mine || !claimBase) return;
        restoreTimeZone(claimBase, env);
        claimBase = undefined;
    };
}
