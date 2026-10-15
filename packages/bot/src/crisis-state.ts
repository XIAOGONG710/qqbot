// 危机信号的记录（ADR 0068 决策 5、6）：只记「哪个联系人、什么时候」，**不记内容**；用来
// - 暂停该联系人的普通主动消息 CRISIS_PAUSE_MS（待跟进和重要的日子不受影响）；
// - 让运营者（用户）在日志和状态页看到触发过。
// 文件：<数据目录>/crisis.json，{ "<qq>": "<ISO 时间>" }。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

/** 检测到危机信号以后，普通主动消息暂停多久（Claude 定的默认值，ADR 0068 待确认 2 用户 10-12 授权） */
export const CRISIS_PAUSE_MS = 48 * 3_600_000;

export interface CrisisState {
    /** 记一次危机信号（只记时间）；同一个人更晚的覆盖早的 */
    mark(qq: number, at: number): void;
    /** 这个人最近一次危机信号的时间 */
    lastAt(qq: number): number | undefined;
    /** 现在是不是还在暂停期里 */
    pausedAt(qq: number, now: number): boolean;
}

export function createCrisisState(dataDir: string, log: (message: string) => void): CrisisState {
    const path = join(dataDir, 'crisis.json');
    const state = readJsonOr<Record<string, string>>(path, {}, log, {
        validate: (value): value is Record<string, string> => Boolean(value && typeof value === 'object' && !Array.isArray(value)
            && Object.entries(value).every(([qq, at]) => /^\d+$/.test(qq) && typeof at === 'string' && Number.isFinite(Date.parse(at)))),
        invalid: 'throw', label: '危机状态',
    });
    return {
        mark(qq, at) {
            const earlier = state[String(qq)] ? Date.parse(state[String(qq)]!) : 0;
            if (at <= earlier) return;
            state[String(qq)] = new Date(at).toISOString();
            writeJsonAtomic(path, state);
        },
        lastAt(qq) {
            const text = state[String(qq)];
            return text ? Date.parse(text) : undefined;
        },
        pausedAt(qq, now) {
            const at = this.lastAt(qq);
            return at !== undefined && now - at < CRISIS_PAUSE_MS;
        },
    };
}
