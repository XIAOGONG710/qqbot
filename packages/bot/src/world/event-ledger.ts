// 世界事件账本：只追加事实、按稳定 id 幂等，不负责影响评估或行动。
// 与 life-events.ts 的“她做过什么”分开：这里记录世界发生过什么。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { TransientStateError } from '../memory/transient-io.ts';
import { appendWorldEvents, validWorldEvent, type WorldEvent } from './events.ts';

interface WorldEventsFile {
    version: 1;
    events: WorldEvent[];
}

export interface WorldEventLedger {
    events(): readonly WorldEvent[];
    append(events: readonly WorldEvent[]): number;
}

function validFile(value: unknown): value is WorldEventsFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const file = value as Partial<WorldEventsFile>;
    return file.version === 1 && Array.isArray(file.events)
        && file.events.every(validWorldEvent)
        && new Set(file.events.map(event => event.id)).size === file.events.length;
}

export function readWorldEventLedger(path: string, log: (message: string) => void = () => undefined): WorldEventLedger {
    let loaded: WorldEventsFile | undefined;
    try {
        loaded = readJsonOr<WorldEventsFile | undefined>(path, undefined, log, {
            validate: (value): value is WorldEventsFile | undefined => value === undefined || validFile(value),
            invalid: 'throw', label: '世界事件账',
        });
    } catch (error) {
        if (error instanceof TransientStateError) throw error;
        throw new Error(`世界事件账 ${path} 读取或校验失败（JSON 或 schema 无效），拒绝启动；原文件未重建，请修复后重试`);
    }

    let current = appendWorldEvents([], loaded?.events ?? []);
    return {
        events: () => current,
        append: incoming => {
            if (incoming.length === 0) return 0;
            const next = appendWorldEvents(current, incoming);
            const added = next.length - current.length;
            if (added === 0) return 0;
            writeJsonAtomic(path, { version: 1, events: next } satisfies WorldEventsFile);
            current = next;
            return added;
        },
    };
}

