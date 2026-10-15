// 心跳（任务书 T3b）：机器人每分钟在数据目录写一个 heartbeat.json，另一个进程（ops/heartbeat-watch-cli.ts）看它多久没更新。
// 为什么：服务守护只看进程在不在、端口通不通；「进程在，但机器人卡住了」（事件循环被占死、插件没跑起来）它看不出来。
// 心跳在机器人自己的事件循环里写：写得出来，说明它在转。只写时间和进程号，不含任何聊天内容。
// 停下（stop）时不删文件：留着的旧心跳正是「它停了」的证据；计划内的停机用维护旗（%TEMP%\qqbot-maintenance）免告警。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './json-file.ts';

export const HEARTBEAT_EVERY_MS = 60_000;
/** 超过这么久没更新就告警 */
export const HEARTBEAT_STALE_MS = 15 * 60_000;

export interface Heartbeat {
    /** 这次写的时间（ISO） */
    at: string;
    pid: number;
    /** 跑着的代码提交（启动脚本给的 QQBOT_GIT_COMMIT；没有就是 unknown） */
    ref: string;
    startedAt: string;
    /** 最近一次连上 NapCat（connected 被调用）的时间 */
    connectedAt?: string;
    /** 最近一次收到私聊消息的时间（只记时间） */
    lastMessageAt?: string;
}

export const heartbeatPath = (dataDir: string) => join(dataDir, 'heartbeat.json');

export interface HeartbeatOptions {
    dataDir: string;
    log?: (message: string) => void;
    now?: () => Date;
    everyMs?: number;
    pid?: number;
    ref?: string;
    /** 每次写之前取：连上 / 收到消息的时间 */
    state?: () => { connectedAt?: Date | undefined; lastMessageAt?: Date | undefined };
}

export interface HeartbeatWriter {
    beat(): void;
    stop(): void;
}

/** 马上写一次，之后每 everyMs 写一次；写失败只记一行日志（每次故障一行），不抛、不挡聊天 */
export function startHeartbeat(options: HeartbeatOptions): HeartbeatWriter {
    const now = options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const ref = options.ref ?? process.env.QQBOT_GIT_COMMIT ?? 'unknown';
    let failing = false;
    const beat = () => {
        const state = options.state?.() ?? {};
        const value: Heartbeat = {
            at: now().toISOString(), pid: options.pid ?? process.pid, ref, startedAt,
            ...(state.connectedAt ? { connectedAt: state.connectedAt.toISOString() } : {}),
            ...(state.lastMessageAt ? { lastMessageAt: state.lastMessageAt.toISOString() } : {}),
        };
        try {
            writeJsonAtomic(heartbeatPath(options.dataDir), value);
            failing = false;
        } catch (error) {
            if (!failing) options.log?.(`心跳：写 heartbeat.json 失败（${error instanceof Error ? error.message : String(error)}）；之后每分钟再试，不再重复记`);
            failing = true;
        }
    };
    beat();
    const timer = setInterval(beat, options.everyMs ?? HEARTBEAT_EVERY_MS);
    timer.unref();
    return { beat, stop: () => clearInterval(timer) };
}

export type HeartbeatVerdict =
    | { state: 'ok'; ageMs: number; heartbeat: Heartbeat }
    | { state: 'stale'; ageMs: number; heartbeat: Heartbeat }
    | { state: 'missing' }
    | { state: 'unreadable' }
    | { state: 'maintenance' };

/** 看一眼心跳：有维护旗就免检；没有文件不算故障（还没部署，或从没启动过）；文件读不了单独报 */
export function checkHeartbeat(dataDir: string, now: Date, options: { maxAgeMs?: number; maintenance?: boolean } = {}): HeartbeatVerdict {
    if (options.maintenance) return { state: 'maintenance' };
    let text: string;
    try {
        text = readFileSync(heartbeatPath(dataDir), 'utf8');
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
    }
    let heartbeat: Heartbeat;
    try {
        heartbeat = JSON.parse(text) as Heartbeat;
        if (typeof heartbeat.at !== 'string' || !Number.isFinite(Date.parse(heartbeat.at))) return { state: 'unreadable' };
    } catch {
        return { state: 'unreadable' };
    }
    const ageMs = now.getTime() - Date.parse(heartbeat.at);
    return { state: ageMs > (options.maxAgeMs ?? HEARTBEAT_STALE_MS) ? 'stale' : 'ok', ageMs, heartbeat };
}

export interface AlertSink {
    raise(message: string): void;
    clear(message: string): void;
}

/**
 * 告警的状态机：故障开始报一次，一直故障不重复报，恢复时报一次。返回新的 alerting 状态。
 * 「读不了」和「过期」都算故障；「没有文件」「维护中」「正常」都不算。
 */
export function watchStep(verdict: HeartbeatVerdict, alerting: boolean, sink: AlertSink, label = '机器人'): boolean {
    const minutes = (ms: number) => Math.round(ms / 60_000);
    if (verdict.state === 'stale') {
        if (!alerting) sink.raise(`${label}的心跳已经 ${minutes(verdict.ageMs)} 分钟没更新（最后一次 ${verdict.heartbeat.at}，pid ${verdict.heartbeat.pid}）：进程可能卡住或已经停了`);
        return true;
    }
    if (verdict.state === 'unreadable') {
        if (!alerting) sink.raise(`${label}的心跳文件读不了或格式不对`);
        return true;
    }
    if (alerting && verdict.state === 'ok') sink.clear(`${label}的心跳恢复了（pid ${verdict.heartbeat.pid}）`);
    // 维护中 / 没有文件：保持原来的状态，不新报也不报恢复
    return verdict.state === 'ok' ? false : alerting;
}
