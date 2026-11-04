// 生活事件账本（ADR 0029）：记录林梦瑶在聊天之外也真实发生过的事。
// 账本只追加、不改写既有事件；具体世界如何受影响由 world.ts 投影，避免把“记过”误当成“成功做完”。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { calendarDate, stateTimestamp } from '../memory/state-schema.ts';
import { TransientStateError } from '../memory/transient-io.ts';

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
    /**
     * 做的是什么。见面（meet）存的是约定原话（「和他去东门吃麻辣烫」），「他」是对约的那个联系人（target）说的：
     * 生活账接进提示词时，别的档位要走 describeAppointment 那种按看的人区分的说法，不能原样给
     */
    subject?: string;
    target?: string;
    /** 这件行动本身也完成了一顿饭（例如约人出去吃饭）。 */
    meal?: boolean;
    /** 收到的钱（世界动作 receive_money），整数元 */
    amount?: number;
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
    amount?: number;
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

export function readLifeEvents(path: string, log: (message: string) => void): LifeEvent[] {
    let loaded: LifeEventsFile | undefined;
    try {
        loaded = readJsonOr<LifeEventsFile | undefined>(path, undefined, log, {
            validate: (value): value is LifeEventsFile => Boolean(value && typeof value === 'object'
                && (value as Partial<LifeEventsFile>).version === 1
                && Array.isArray((value as Partial<LifeEventsFile>).events)
                && (value as Partial<LifeEventsFile>).events!.every(validLifeEvent)
                && new Set((value as LifeEventsFile).events.map(event => event.id)).size === (value as LifeEventsFile).events.length),
            invalid: 'throw', label: '生活事件账',
        });
    } catch (error) {
        if (error instanceof TransientStateError) throw error;
        // JSON 解析异常可能包含事件正文；错误分类保留，私密内容不交给普通日志。
        throw new Error(`生活事件账 ${path} 读取或校验失败（JSON 或 schema 无效），拒绝启动；原文件未重建，请修复后重试`);
    }
    return loaded?.events ?? [];
}

export function writeLifeEvents(path: string, events: readonly LifeEvent[]): void {
    if (!events.every(validLifeEvent) || new Set(events.map(event => event.id)).size !== events.length) {
        throw new Error('生活事件账写入内容不符合 schema；原文件未改动');
    }
    writeJsonAtomic(path, { version: 1, events });
}

export function validLifeEvent(value: unknown): value is LifeEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<LifeEvent>;
    const start = typeof event.startedAt === 'string' ? Date.parse(event.startedAt) : NaN;
    const end = typeof event.endedAt === 'string' ? Date.parse(event.endedAt) : NaN;
    return typeof event.id === 'string' && event.id.trim().length > 0
        && event.actor === 'linmengyao'
        && typeof event.kind === 'string' && event.kind.trim().length > 0
        && typeof event.day === 'string' && calendarDate(event.day)
        && stateTimestamp(event.startedAt) && stateTimestamp(event.endedAt) && start <= end
        && typeof event.source === 'string' && SOURCES.has(event.source as LifeEventSource)
        && typeof event.result === 'string' && RESULTS.has(event.result as LifeEventResult)
        && (event.reason === undefined || typeof event.reason === 'string')
        && (event.subject === undefined || typeof event.subject === 'string')
        && (event.target === undefined || typeof event.target === 'string')
        && (event.meal === undefined || typeof event.meal === 'boolean')
        && (event.amount === undefined || (Number.isSafeInteger(event.amount) && event.amount > 0))
        && (event.seen === undefined || typeof event.seen === 'boolean')
        && (event.contact === undefined || (Number.isSafeInteger(event.contact) && event.contact >= 0))
        && (event.episode === undefined || typeof event.episode === 'string');
}
