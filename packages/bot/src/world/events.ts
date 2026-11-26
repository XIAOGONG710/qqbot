// 世界事件的最小事实层。
// 这里只记录“世界发生了什么”，不判断她该不该说话，也不直接触发活动。
// 事件来源、影响评估、动机和执行器留给上层；同一事件可被多个模块消费。

export const WORLD_EVENT_SOURCES = ['user', 'relationship', 'society', 'world', 'time', 'task', 'media', 'system', 'sandbox'] as const;
export type WorldEventSource = (typeof WORLD_EVENT_SOURCES)[number];

export const WORLD_EVENT_STATUSES = ['active', 'resolved', 'expired', 'dismissed'] as const;
export type WorldEventStatus = (typeof WORLD_EVENT_STATUSES)[number];

export type WorldEventValue = string | number | boolean | null;

/** 可持久化、可审计的外部事件；details 不放原始供应商正文或密钥。 */
export interface WorldEvent {
    /** 调用方提供的稳定幂等键。 */
    id: string;
    source: WorldEventSource;
    /** 开放集合：消费者只处理自己认识的 kind。 */
    kind: string;
    /** 事件实际发生的时间。 */
    occurredAt: string;
    /** 系统观察到它的时间。 */
    observedAt: string;
    /** 可选的失效时间；过期后不能继续当作当前事实。 */
    validUntil?: string;
    status: WorldEventStatus;
    /** 事件影响或指向的实体，例如 user:123、place:school。 */
    subjects?: readonly string[];
    /** 结构化小字段；不放未经清洗的正文。 */
    details?: Readonly<Record<string, WorldEventValue>>;
    /** 来源可信度，0 到 1；未知时由调用方明确给出，而不是省略。 */
    confidence: number;
}

const SOURCE_SET = new Set<string>(WORLD_EVENT_SOURCES);
const STATUS_SET = new Set<string>(WORLD_EVENT_STATUSES);
const ISO = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validValue = (value: unknown): value is WorldEventValue => value === null
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

export function validWorldEvent(value: unknown): value is WorldEvent {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const event = value as Partial<WorldEvent>;
    if (!nonEmpty(event.id) || !SOURCE_SET.has(event.source as string) || !nonEmpty(event.kind)
        || !ISO(event.occurredAt) || !ISO(event.observedAt) || !STATUS_SET.has(event.status as string)
        || typeof event.confidence !== 'number' || !Number.isFinite(event.confidence)
        || event.confidence < 0 || event.confidence > 1) return false;
    if (event.validUntil !== undefined && !ISO(event.validUntil)) return false;
    if (event.validUntil !== undefined && Date.parse(event.validUntil) < Date.parse(event.occurredAt)) return false;
    if (event.subjects !== undefined && (!Array.isArray(event.subjects) || !event.subjects.every(nonEmpty))) return false;
    if (event.details !== undefined) {
        if (!event.details || typeof event.details !== 'object' || Array.isArray(event.details)) return false;
        if (!Object.values(event.details).every(validValue)) return false;
    }
    return true;
}

/** 幂等追加世界事件；已有 id 保留原记录，避免重复观察改写事实。 */
export function appendWorldEvents(existing: readonly WorldEvent[], incoming: readonly WorldEvent[]): WorldEvent[] {
    const byId = new Map<string, WorldEvent>();
    for (const event of [...existing, ...incoming]) {
        if (!validWorldEvent(event)) {
            const id = event && typeof event === 'object' ? String((event as { id?: unknown }).id ?? 'unknown') : 'unknown';
            throw new Error(`世界事件格式无效：${id}`);
        }
        if (!byId.has(event.id)) byId.set(event.id, event);
    }
    return [...byId.values()].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
        || Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id, 'zh-CN'));
}

