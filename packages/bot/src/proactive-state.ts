// 已发送/已跳过记录是主动消息去重的事实源；坏状态不能清空后继续计划。
import type { FollowUp } from './follow-ups.ts';
import { readJsonOr } from './json-file.ts';
import { OBSTACLE_KINDS } from './obstacles.ts';
import { OCCASIONS, UNREACHABLE_MAX_TRIES, type ProactiveRecord } from './proactive.ts';
import { calendarDate, stateObject, stateTimestamp } from './state-schema.ts';

export interface ProactiveState {
    version: 1;
    records: ProactiveRecord[];
    followUps: FollowUp[];
    extracted: Record<string, true | number>;
}

export const emptyProactiveState = (): ProactiveState => ({ version: 1, records: [], followUps: [], extracted: {} });
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const id = (value: unknown): value is string => text(value) && !/[\x00-\x1f\x7f]/.test(value);
const episodeId = (value: unknown): value is string => typeof value === 'string' && /^ep-(-?(?:0|[1-9]\d*))$/.test(value)
    && Number.isSafeInteger(Number(value.slice(3))) && Math.abs(Number(value.slice(3))) <= 8_640_000_000_000_000;
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

function validRecord(value: unknown): value is ProactiveRecord {
    if (!stateObject(value) || !id(value.id)) return false;
    const [date, occasion] = value.id.split(':');
    return calendarDate(date!) && OCCASIONS.includes(value.occasion as ProactiveRecord['occasion']) && occasion === value.occasion
        && stateTimestamp(value.plannedAt) && stateTimestamp(value.at)
        && ['sent', 'dryRun', 'skipped', 'failed'].includes(String(value.result))
        && optional(value.reason, v => typeof v === 'string')
        && optional(value.messageIds, v => Array.isArray(v) && v.every(Number.isSafeInteger))
        && optional(value.tries, v => value.result === 'failed' && integer(v, 1, UNREACHABLE_MAX_TRIES))
        && optional(value.obstacle, v => value.occasion === 'reschedule' && OBSTACLE_KINDS.includes(v as typeof OBSTACLE_KINDS[number]))
        && optional(value.retryAt, v => value.result === 'failed' && stateTimestamp(v)
            && Date.parse(v) > Date.parse(value.at as string) && integer(value.tries, 1, UNREACHABLE_MAX_TRIES - 1)
            && (!Array.isArray(value.messageIds) || !value.messageIds.length));
}

function validFollowUp(value: unknown): value is FollowUp {
    return stateObject(value) && id(value.id) && text(value.what) && typeof value.date === 'string' && calendarDate(value.date)
        && typeof value.time === 'string' && (/^(?:morning|afternoon|evening)$/.test(value.time) || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time))
        && episodeId(value.episode) && optional(value.missed, v => integer(v, 0, 1));
}

const unique = (values: { id: string }[]) => new Set(values.map(v => v.id)).size === values.length;
export function validProactiveState(value: unknown): value is ProactiveState {
    return stateObject(value) && value.version === 1
        && Array.isArray(value.records) && value.records.every(validRecord) && unique(value.records)
        && Array.isArray(value.followUps) && value.followUps.every(validFollowUp) && unique(value.followUps)
        && stateObject(value.extracted) && Object.entries(value.extracted).every(([key, attempts]) => episodeId(key) && (attempts === true || integer(attempts, 0, 2)));
}

export function readProactiveState(path: string): ProactiveState {
    try {
        return readJsonOr(path, emptyProactiveState(), undefined, {
            migrate: value => stateObject(value) && value.version === undefined
                ? { followUps: [], extracted: {}, ...value, version: 1 } : value,
            validate: validProactiveState, invalid: 'throw', label: '主动消息状态',
        });
    } catch {
        throw new Error(`主动消息状态 ${path} 读取或校验失败；暂停主动消息，原文件未重建，请修复或从可信备份恢复`);
    }
}
