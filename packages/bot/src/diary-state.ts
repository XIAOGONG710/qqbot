import { readJsonOr } from './json-file.ts';
import { calendarDate, stateObject } from './state-schema.ts';

export interface DiaryState {
    version: 1;
    written: Record<string, number>;
    texts: Record<string, string>;
    weeks: Record<string, number>;
    phases: Record<string, number>;
    forgotten: Record<string, boolean>;
}

const emptyDiary = (): DiaryState => ({ version: 1, written: {}, texts: {}, weeks: {}, phases: {}, forgotten: {} });
const record = (value: unknown, key: (key: string) => boolean, item: (value: unknown) => boolean): boolean =>
    stateObject(value) && Object.entries(value).every(([k, v]) => key(k) && item(v));
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

/** 新旧写入者共用：丢失 forgotten 会使已遗忘日记重新读回，损坏必须保留原文件并停止。 */
export function readDiaryState(path: string, log: (message: string) => void = () => {}): DiaryState {
    return readJsonOr<DiaryState>(path, emptyDiary(), log, {
        migrate: value => stateObject(value) && value.version === undefined
            ? { ...emptyDiary(), ...value, version: 1 } : value,
        validate: (value): value is DiaryState => stateObject(value) && value.version === 1
            && record(value.written, calendarDate, count)
            && record(value.texts, calendarDate, v => typeof v === 'string')
            && record(value.weeks, calendarDate, count)
            && record(value.phases, k => /^.+:\d{4}-\d{2}-\d{2}$/.test(k) && calendarDate(k.slice(-10)), count)
            && record(value.forgotten, calendarDate, v => v === true),
        invalid: 'throw', label: '日记与遗忘状态',
    });
}
