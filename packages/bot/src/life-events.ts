// 生活事件账本（ADR 0029）：记录林梦瑶在聊天之外也真实发生过的事。
// 账本只追加、不改写既有事件；具体世界如何受影响由 world.ts 投影，避免把“记过”误当成“成功做完”。

import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export type LifeEventSource = 'conversation' | 'simulation' | 'external';
export type LifeEventResult = 'succeeded' | 'failed' | 'interrupted';

export interface LifeEvent {
    /** 调用方提供的稳定幂等键。 */
    id: string;
    actor: 'linmengyao';
    /** 开放集合：世界层只消费自己认识的 kind，其余事件仍可供日记、记忆和未来状态机使用。 */
    kind: string;
    /** 按她的作息归属的生活日。 */
    day: string;
    /** ISO 时间；耗时事件可有不同的开始、结束时间。 */
    startedAt: string;
    endedAt: string;
    source: LifeEventSource;
    result: LifeEventResult;
    /** 世界裁判给出的可审计原因；成功时通常没有。 */
    reason?: string;
    subject?: string;
    target?: string;
    /** 这件行动本身也完成了一顿饭（例如约人出去吃饭）。 */
    meal?: boolean;
    seen?: boolean;
    /** 对话来源的审计线索；模拟和外部事件可以没有。 */
    contact?: number;
    episode?: string;
}

export interface LifeEventDraft {
    id: string;
    kind: string;
    at: string;
    startedAt?: string;
    source: LifeEventSource;
    result: LifeEventResult;
    reason?: string;
    subject?: string;
    target?: string;
    meal?: boolean;
    seen?: boolean;
    contact?: number;
    episode?: string;
}

interface LifeEventsFile {
    version: 1;
    events: LifeEvent[];
}

const SOURCES = new Set<LifeEventSource>(['conversation', 'simulation', 'external']);
const RESULTS = new Set<LifeEventResult>(['succeeded', 'failed', 'interrupted']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function readLifeEvents(path: string, log: (message: string) => void): LifeEvent[] {
    const loaded = readJsonOr<Partial<LifeEventsFile>>(path, {}, log);
    return (Array.isArray(loaded.events) ? loaded.events : []).filter(validLifeEvent);
}

export function writeLifeEvents(path: string, events: readonly LifeEvent[]): void {
    writeJsonAtomic(path, { version: 1, events });
}

export function validLifeEvent(value: unknown): value is LifeEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<LifeEvent>;
    const start = typeof event.startedAt === 'string' ? Date.parse(event.startedAt) : NaN;
    const end = typeof event.endedAt === 'string' ? Date.parse(event.endedAt) : NaN;
    return typeof event.id === 'string' && event.id.length > 0
        && event.actor === 'linmengyao'
        && typeof event.kind === 'string' && event.kind.length > 0
        && typeof event.day === 'string' && DATE_ONLY.test(event.day)
        && Number.isFinite(start) && Number.isFinite(end) && start <= end
        && typeof event.source === 'string' && SOURCES.has(event.source as LifeEventSource)
        && typeof event.result === 'string' && RESULTS.has(event.result as LifeEventResult)
        && (event.reason === undefined || typeof event.reason === 'string')
        && (event.subject === undefined || typeof event.subject === 'string')
        && (event.target === undefined || typeof event.target === 'string')
        && (event.meal === undefined || typeof event.meal === 'boolean')
        && (event.seen === undefined || typeof event.seen === 'boolean')
        && (event.contact === undefined || typeof event.contact === 'number')
        && (event.episode === undefined || typeof event.episode === 'string');
}
