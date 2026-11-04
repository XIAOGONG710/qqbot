// 连续需要的事实投影（ADR 0045，B 阶段第一步）。
// 精力、饥饿和压力只由一个锚点、时间流逝与已经落账的行动推出来；不另写一份会和事件账漂移的当前值。

import { existsSync } from 'node:fs';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { LifeEvent } from '.././world/life-events.ts';

export interface NeedsSnapshot {
    at: string;
    /** 0 是耗尽，100 是休息充分。 */
    energy: number;
    /** 0 是吃饱，100 是很饿。 */
    hunger: number;
    /** 0 是放松，100 是压力很大。 */
    stress: number;
}

interface NeedsAnchorFile {
    version: 1;
    /** 改速率或离散后果时必须换版本并显式迁移锚点，不能拿新规则重算旧历史。 */
    rulesVersion: typeof NEEDS_RULES_VERSION;
    anchor: NeedsSnapshot;
}

export const NEEDS_RULES_VERSION = 'needs-v1' as const;
export const DEFAULT_NEEDS = { energy: 68, hunger: 35, stress: 24 } as const;

interface Rates {
    energy: number;
    hunger: number;
    stress: number;
}

const AWAKE: Rates = { energy: -1.8, hunger: 3, stress: -0.1 };
const RATES: Record<string, Rates> = {
    sleep: { energy: 8, hunger: 0.8, stress: -2 },
    rest: { energy: 2, hunger: 3, stress: -3 },
    leisure: { energy: -1.3, hunger: 3, stress: -1.2 },
    read_book: { energy: -1.5, hunger: 3, stress: -0.8 },
    interact_npc: { energy: -1.2, hunger: 3, stress: -1.5 },
    meet: { energy: -2, hunger: 3, stress: -1.4 },
    attend_class: { energy: -2.5, hunger: 3.2, stress: 1.2 },
    study: { energy: -3, hunger: 3.2, stress: 2 },
    work_on_project: { energy: -2.2, hunger: 3.1, stress: 0.8 },
};

/** 吃完一顿才结算饱腹；做到一半被打断的饭不算吃完。 */
const MEAL_HUNGER_RELIEF = 55;

/**
 * 第一次启用时把需要起点写进运行目录；之后只读同一个起点。规则版本不一致时拒绝偷偷重算，
 * 由升级代码先把旧规则投影到切换时刻，再写入新版本锚点。
 */
export function loadNeedsAnchor(path: string, at: Date, log: (message: string) => void = () => undefined): NeedsSnapshot {
    const existed = existsSync(path);
    const loaded = readJsonOr<Partial<NeedsAnchorFile>>(path, {}, message => log(`她的需要：${message}`), existed ? {
        validate: (value): value is NeedsAnchorFile => Boolean(value && typeof value === 'object'
            && (value as Partial<NeedsAnchorFile>).version === 1
            && typeof (value as Partial<NeedsAnchorFile>).rulesVersion === 'string'
            && validSnapshot((value as Partial<NeedsAnchorFile>).anchor, at)),
        invalid: 'throw', label: '需要锚点',
    } : {});
    if (loaded.rulesVersion && loaded.rulesVersion !== NEEDS_RULES_VERSION) {
        throw new Error(`需要规则版本不兼容：${loaded.rulesVersion} → ${NEEDS_RULES_VERSION}，必须先迁移锚点`);
    }
    if (loaded.version === 1 && loaded.rulesVersion === NEEDS_RULES_VERSION && validSnapshot(loaded.anchor, at)) return loaded.anchor!;
    const anchor = snapshot(at, DEFAULT_NEEDS);
    writeJsonAtomic(path, { version: 1, rulesVersion: NEEDS_RULES_VERSION, anchor } satisfies NeedsAnchorFile);
    log(`她的需要：建立 ${NEEDS_RULES_VERSION} 锚点（${anchor.at}）`);
    return anchor;
}

/**
 * 把需要从 anchor 推到 at。同一锚点、事件账和时刻永远得到同一个结果；失败事件不产生身体后果。
 * 事件之间的空当按普通清醒时间计算，重叠事件按稳定优先级只取一件，避免坏账把变化算两遍。
 */
export function needsAt(anchor: NeedsSnapshot, events: readonly LifeEvent[], at: Date): NeedsSnapshot {
    const anchorAt = Date.parse(anchor.at);
    const target = at.getTime();
    if (!Number.isFinite(anchorAt) || !Number.isFinite(target)) throw new RangeError('需要投影的时间不合法');
    if (![anchor.energy, anchor.hunger, anchor.stress].every(Number.isFinite)) throw new RangeError('需要锚点不是有限数字');
    if (target < anchorAt) throw new RangeError('需要投影不能早于锚点');
    if (target === anchorAt) return snapshot(at, anchor);

    const relevant = effectiveLifeEvents(events)
        .filter(event => event.result !== 'failed')
        .map(event => ({ event, start: Date.parse(event.startedAt), end: Date.parse(event.endedAt) }))
        .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > anchorAt && item.start < target && item.end >= item.start)
        .sort((a, b) => a.start - b.start || a.end - b.end || a.event.id.localeCompare(b.event.id));
    const boundaries = [...new Set([
        anchorAt,
        target,
        ...relevant.flatMap(item => [Math.max(anchorAt, item.start), Math.min(target, item.end)]),
    ])].sort((a, b) => a - b);

    let energy = clamp(anchor.energy);
    let hunger = clamp(anchor.hunger);
    let stress = clamp(anchor.stress);
    const activeEventIds = new Set<string>();
    for (let i = 0; i < boundaries.length - 1; i++) {
        const from = boundaries[i]!;
        const to = boundaries[i + 1]!;
        if (to <= from) continue;
        const active = relevant.find(item => item.start <= from && item.end >= to)?.event;
        if (active) activeEventIds.add(active.id);
        const rates = active ? (RATES[active.kind] ?? AWAKE) : AWAKE;
        const hours = (to - from) / 3_600_000;
        energy = clamp(energy + rates.energy * hours);
        hunger = clamp(hunger + rates.hunger * hours);
        stress = clamp(stress + rates.stress * hours);

        // 离散后果只在事件真正结束且落在这次投影区间里结算；分段重启不会重复吃饭。
        for (const item of relevant) {
            if (item.end !== to || item.end <= anchorAt || item.end > target) continue;
            if (!activeEventIds.has(item.event.id)) continue;
            if ((item.event.kind === 'eat' || item.event.meal) && item.event.result === 'succeeded') hunger = clamp(hunger - MEAL_HUNGER_RELIEF);
        }
    }
    return snapshot(at, { energy, hunger, stress });
}

function dedupe(events: readonly LifeEvent[]): LifeEvent[] {
    const byId = new Map<string, LifeEvent>();
    for (const event of events) if (!byId.has(event.id)) byId.set(event.id, event);
    return [...byId.values()];
}

/**
 * 选出冲突时间轴上真正生效的行动。不同 ID 的重叠事实也只能占用同一段现实时间；
 * 稳定顺序与需要投影一致。失败尝试没有占用时段，但仍保留给心理余波结算。
 */
export function effectiveLifeEvents(events: readonly LifeEvent[]): LifeEvent[] {
    const unique = dedupe(events);
    const candidates = unique
        .filter(event => event.result !== 'failed')
        .map(event => ({ event, start: Date.parse(event.startedAt), end: Date.parse(event.endedAt) }))
        .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
        .sort((a, b) => a.start - b.start || a.end - b.end || a.event.id.localeCompare(b.event.id));
    const boundaries = [...new Set(candidates.flatMap(item => [item.start, item.end]))].sort((a, b) => a - b);
    const active = new Set<string>();
    for (let index = 0; index < boundaries.length - 1; index++) {
        const from = boundaries[index]!;
        const to = boundaries[index + 1]!;
        const winner = candidates.find(item => item.start <= from && item.end >= to);
        if (winner) active.add(winner.event.id);
    }
    return unique.filter(event => event.result === 'failed' || active.has(event.id));
}

function snapshot(at: Date, values: Pick<NeedsSnapshot, 'energy' | 'hunger' | 'stress'>): NeedsSnapshot {
    return {
        at: at.toISOString(),
        energy: rounded(clamp(values.energy)),
        hunger: rounded(clamp(values.hunger)),
        stress: rounded(clamp(values.stress)),
    };
}

function validSnapshot(value: unknown, notAfter: Date): value is NeedsSnapshot {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<NeedsSnapshot>;
    const at = typeof item.at === 'string' ? Date.parse(item.at) : NaN;
    return Number.isFinite(at) && at <= notAfter.getTime()
        && [item.energy, item.hunger, item.stress].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 100);
}

function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
function rounded(value: number): number { return Math.round(value * 1000) / 1000; }
