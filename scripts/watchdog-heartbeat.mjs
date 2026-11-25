// 守护心跳：常驻的守护每次检查前写一份 { pid, at }，DSH 面板据此判断「自动守护」在不在跑。
// 守护日志只在出事时才写（启动、拉起、恢复、告警），一切正常时最后一行可能是几个小时前的，不能当心跳用。
import { readFileSync, writeFileSync } from 'node:fs';

export const HEARTBEAT_FILE = 'runtime/services-watchdog.heartbeat.json';
/** 守护每分钟查一次，但一次检查可能被每天的备份拖住（备份超时 15 分钟），所以 20 分钟没心跳才算停了 */
export const HEARTBEAT_STALE_MS = 20 * 60_000;

export function writeHeartbeat(file, { pid = process.pid, now = Date.now() } = {}) {
    try {
        writeFileSync(file, JSON.stringify({ pid, at: now }));
        return true;
    } catch {
        return false; // 写不进去不影响守护本身
    }
}

export function readHeartbeat(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return Number.isSafeInteger(value?.pid) && value.pid > 0 && Number.isFinite(value.at) ? value : null;
    } catch {
        return null;
    }
}

/** 进程还在不在：signal 0 只做存在性检查，不发信号；EPERM 说明进程在、只是没权限 */
export function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

/**
 * 有心跳就按心跳判：写心跳的进程还在、心跳又不旧，才算在跑。
 * 没有心跳文件（守护还是旧版本、或从来没跑过）返回 null，由调用方决定怎么显示。
 */
export function heartbeatRunning(file, now = Date.now(), alive = pidAlive) {
    const beat = readHeartbeat(file);
    if (!beat) return null;
    return now - beat.at < HEARTBEAT_STALE_MS && now - beat.at > -60_000 && alive(beat.pid);
}
