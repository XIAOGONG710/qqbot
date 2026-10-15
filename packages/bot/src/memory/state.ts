// 记忆写入进度与公共迁移标记：不能隔离坏文件后从空状态重放或假定已完成迁移。
import { readJsonOr } from '../json-file.ts';
import { stateObject } from '../state-schema.ts';

export interface ContactMemoryState {
    version: 1;
    bankId: string;
    bankConfigured?: string;
    /** 旧版用 boolean，之后改成设定版本字符串。 */
    relationshipModel?: string | boolean;
    personModel?: string;
    retained: Record<string, number>;
    common?: Record<string, number>;
    commonSafetyVersion?: 2;
}

export interface CommonMemoryState {
    version: 1;
    bankId: string;
    bankConfigured?: string;
    writtenSafetyVersion?: 2;
}

const identifier = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const optional = (value: unknown, valid: (value: unknown) => boolean) => value === undefined || valid(value);
const progress = (value: unknown): value is Record<string, number> => stateObject(value)
    && Object.entries(value).every(([id, count]) => /^ep-(-?(?:0|[1-9]\d*))$/.test(id)
        && Number.isSafeInteger(Number(id.slice(3))) && Math.abs(Number(id.slice(3))) <= 8_640_000_000_000_000
        && Number.isSafeInteger(count) && Number(count) >= 0);

export const validContactMemoryState = (value: unknown): value is ContactMemoryState => stateObject(value)
    && value.version === 1 && identifier(value.bankId) && progress(value.retained)
    && optional(value.bankConfigured, identifier) && optional(value.personModel, identifier)
    && optional(value.relationshipModel, v => typeof v === 'boolean' || identifier(v))
    && optional(value.common, progress) && optional(value.commonSafetyVersion, v => v === 2)
    && (value.commonSafetyVersion !== 2 || progress(value.common));

export const validCommonMemoryState = (value: unknown): value is CommonMemoryState => stateObject(value)
    && value.version === 1 && identifier(value.bankId) && optional(value.bankConfigured, identifier)
    && optional(value.writtenSafetyVersion, v => v === 2);

function readState<T>(path: string, label: string, validate: (value: unknown) => value is T): T | undefined {
    try {
        return readJsonOr<T | undefined>(path, undefined, undefined, {
            migrate: value => stateObject(value) && value.version === undefined ? { ...value, version: 1 } : value,
            validate: (value): value is T => validate(value), invalid: 'throw', label,
        });
    } catch {
        // JSON.parse 的错误可能带正文片段，不把原始解析错误带到日志/离线报告。
        throw new Error(`${label} ${path} 读取或校验失败；拒绝继续操作，原文件未重建，请修复或从可信备份恢复`);
    }
}

/** 文件不存在才返回 undefined；已有的空对象、缺进度字段或未知版本不是“首次使用”。 */
export const readContactMemoryState = (path: string): ContactMemoryState | undefined =>
    readState(path, '联系人记忆进度', validContactMemoryState);
export const readCommonMemoryState = (path: string): CommonMemoryState | undefined =>
    readState(path, '公共记忆迁移状态', validCommonMemoryState);
