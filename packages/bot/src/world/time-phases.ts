// 世界时钟的阶段投影：把绝对时间变成可供世界和认知层消费的背景状态。
// 这里只生成“阶段变化”事件，不把某个时间直接等同于主动消息。

import type { WorldEvent } from './events.ts';
import { localDate } from '../local-date.ts';

export const DAY_PHASES = ['night', 'morning', 'noon', 'afternoon', 'evening', 'late-night'] as const;
export type DayPhase = (typeof DAY_PHASES)[number];
export const WEEK_PHASES = ['weekday', 'weekend'] as const;
export type WeekPhase = (typeof WEEK_PHASES)[number];
export const MONTH_PHASES = ['early', 'middle', 'late'] as const;
export type MonthPhase = (typeof MONTH_PHASES)[number];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export interface TimePhases {
    dayPhase: DayPhase;
    weekPhase: WeekPhase;
    monthPhase: MonthPhase;
    season: Season;
}

const pad = (value: number): string => String(value).padStart(2, '0');
const localKey = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;

export function timePhases(at: Date): TimePhases {
    if (!Number.isFinite(at.getTime())) throw new RangeError('世界时钟的时间不合法');
    const hour = at.getHours();
    const dayPhase: DayPhase = hour < 6 ? 'night'
        : hour < 11 ? 'morning'
            : hour < 14 ? 'noon'
                : hour < 18 ? 'afternoon'
                    : hour < 23 ? 'evening' : 'late-night';
    const month = at.getMonth() + 1;
    const season: Season = month <= 2 || month === 12 ? 'winter'
        : month <= 5 ? 'spring'
            : month <= 8 ? 'summer'
                : 'autumn';
    return {
        dayPhase,
        weekPhase: at.getDay() === 0 || at.getDay() === 6 ? 'weekend' : 'weekday',
        monthPhase: at.getDate() <= 10 ? 'early' : at.getDate() <= 20 ? 'middle' : 'late',
        season,
    };
}

/** 只为实际改变的阶段生成事件；相同快照不会重复产生事件。 */
export function timePhaseEvents(before: TimePhases, at: Date, observed = at): WorldEvent[] {
    const after = timePhases(at);
    const occurredAt = at.toISOString();
    const observedAt = observed.toISOString();
    const changes: [keyof TimePhases, string, string][] = [
        ['dayPhase', before.dayPhase, after.dayPhase],
        ['weekPhase', before.weekPhase, after.weekPhase],
        ['monthPhase', before.monthPhase, after.monthPhase],
        ['season', before.season, after.season],
    ];
    return changes
        .filter(([, from, to]) => from !== to)
        .map(([axis, from, to]) => ({
            id: `time:${axis}:${localKey(at)}:${to}`,
            source: 'time' as const,
            kind: `time.${axis}.changed`,
            occurredAt,
            observedAt,
            status: 'active' as const,
            subjects: [`time:${axis}`],
            details: { from, to },
            confidence: 1,
        }));
}

const DAY_BOUNDARY_HOURS = [0, 6, 11, 14, 18, 23] as const;

/**
 * 确定性的世界时钟可以在停机后重放：阶段变化发生在真实边界，observedAt 才是恢复后看到它的时刻。
 * 天气、新闻等观测事实不能用这条路补造，只有纯时间可以这样恢复连续性。
 */
export function timePhaseTransitions(fromExclusive: Date, toInclusive: Date): WorldEvent[] {
    if (!Number.isFinite(fromExclusive.getTime()) || !Number.isFinite(toInclusive.getTime())) throw new RangeError('世界时钟的时间不合法');
    if (toInclusive <= fromExclusive) return [];
    const boundaries: Date[] = [];
    let day = localDate(fromExclusive.getFullYear(), fromExclusive.getMonth(), fromExclusive.getDate());
    const lastDay = localDate(toInclusive.getFullYear(), toInclusive.getMonth(), toInclusive.getDate());
    while (day <= lastDay) {
        for (const hour of DAY_BOUNDARY_HOURS) {
            const boundary = localDate(day.getFullYear(), day.getMonth(), day.getDate(), hour);
            if (boundary > fromExclusive && boundary <= toInclusive) boundaries.push(boundary);
        }
        day = localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    }
    let before = timePhases(fromExclusive);
    return boundaries.flatMap(boundary => {
        const events = timePhaseEvents(before, boundary, toInclusive);
        before = timePhases(boundary);
        return events;
    });
}

