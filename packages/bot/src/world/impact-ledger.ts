// 世界影响账本：保存对世界事件的可审计评估。
// 它依赖世界事件账，但不做事件解释；调用方必须明确给出影响。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { TransientStateError } from '../memory/transient-io.ts';
import type { WorldEvent } from './events.ts';
import { appendWorldImpacts, validWorldImpact, type WorldImpact } from './impacts.ts';

interface WorldImpactsFile {
    version: 1;
    impacts: WorldImpact[];
}

export interface WorldImpactLedger {
    impacts(): readonly WorldImpact[];
    append(impacts: readonly WorldImpact[]): number;
}

function validFile(value: unknown): value is WorldImpactsFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const file = value as Partial<WorldImpactsFile>;
    return file.version === 1 && Array.isArray(file.impacts)
        && file.impacts.every(validWorldImpact)
        && new Set(file.impacts.map(impact => impact.id)).size === file.impacts.length;
}

export function readWorldImpactLedger(path: string, events: () => readonly WorldEvent[], log: (message: string) => void = () => undefined): WorldImpactLedger {
    let loaded: WorldImpactsFile | undefined;
    try {
        loaded = readJsonOr<WorldImpactsFile | undefined>(path, undefined, log, {
            validate: (value): value is WorldImpactsFile | undefined => value === undefined || validFile(value),
            invalid: 'throw', label: '世界影响账',
        });
    } catch (error) {
        if (error instanceof TransientStateError) throw error;
        throw new Error(`世界影响账 ${path} 读取或校验失败（JSON 或 schema 无效），拒绝启动；原文件未重建，请修复后重试`);
    }

    let current = appendWorldImpacts(events(), [], loaded?.impacts ?? []);
    return {
        impacts: () => current,
        append: incoming => {
            if (incoming.length === 0) return 0;
            const next = appendWorldImpacts(events(), current, incoming);
            const added = next.length - current.length;
            if (added === 0) return 0;
            writeJsonAtomic(path, { version: 1, impacts: next } satisfies WorldImpactsFile);
            current = next;
            return added;
        },
    };
}

