// 承诺、未了事项与抽取进度必须共同校验；未知约定不能解释成空日历。
import { readJsonOr } from './json-file.ts';
import type { OpenLoop } from './open-loops.ts';
import type { HerPromise } from './promises.ts';
import { calendarDate, stateObject } from './state-schema.ts';

export interface PromiseState {
    version: 1;
    promises: HerPromise[];
    loops: OpenLoop[];
    extracted: Record<string, true | number>;
    early: Record<string, number>;
}

export class PromiseStateUnavailable extends Error {}
export const emptyPromiseState = (): PromiseState => ({ version: 1, promises: [], loops: [], extracted: {}, early: {} });
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const id = (value: unknown): value is string => text(value) && !/[\x00-\x1f\x7f]/.test(value);
const episodeId = (value: unknown): value is string => typeof value === 'string' && /^ep-(-?(?:0|[1-9]\d*))$/.test(value)
    && Number.isSafeInteger(Number(value.slice(3))) && Math.abs(Number(value.slice(3))) <= 8_640_000_000_000_000;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const dated = (value: unknown): value is string => typeof value === 'string' && calendarDate(value);
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const base = (value: unknown): value is Record<string, unknown> => stateObject(value)
    && id(value.id) && text(value.what) && dated(value.said) && episodeId(value.episode) && optional(value.date, dated);

function validPromise(value: unknown): value is HerPromise {
    if (!base(value) || !optional(value.early, v => v === true)) return false;
    if (value.meet === undefined) return value.early === undefined;
    if (!dated(value.date) || !stateObject(value.meet)) return false;
    const meet = value.meet;
    if (typeof meet.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(meet.time)
        || !count(meet.minutes) || Number(meet.minutes) === 0 || !optional(meet.where, text)) return false;
    const end = Date.parse(`${value.date}T${meet.time}:00Z`) + Number(meet.minutes) * 60_000
        + (Number(meet.time.slice(0, 2)) < 5 ? 86_400_000 : 0);
    return Number.isFinite(end) && Math.abs(end) <= 8_640_000_000_000_000;
}

const validLoop = (value: unknown): value is OpenLoop => base(value)
    && ['waiting', 'unanswered', 'unsettled'].includes(String(value.kind));

export function validPromiseState(value: unknown): value is PromiseState {
    if (!stateObject(value) || value.version !== 1 || !Array.isArray(value.promises) || !value.promises.every(validPromise)
        || !Array.isArray(value.loops) || !value.loops.every(validLoop) || !stateObject(value.extracted) || !stateObject(value.early)) return false;
    const ids = [...value.promises, ...value.loops].map(item => item.id);
    return new Set(ids).size === ids.length
        && Object.entries(value.extracted).every(([key, attempts]) => episodeId(key) && (attempts === true || (count(attempts) && Number(attempts) <= 2)))
        && Object.entries(value.early).every(([key, length]) => episodeId(key) && count(length));
}

export function readPromiseState(path: string): PromiseState {
    try {
        return readJsonOr(path, emptyPromiseState(), undefined, {
            migrate: value => stateObject(value) && value.version === undefined ? { loops: [], early: {}, ...value, version: 1 } : value,
            validate: validPromiseState, invalid: 'throw', label: '承诺状态',
        });
    } catch {
        throw new PromiseStateUnavailable(`承诺状态 ${path} 读取或校验失败；原文件未重建，约定暂不可确认，请修复或从可信备份恢复`);
    }
}
