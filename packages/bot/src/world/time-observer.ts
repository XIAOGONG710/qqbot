// 时间观察器：把世界时钟的阶段变化写入事件账。
// 这是感知器，不是定时器，也不决定任何主动行为；宿主以后自行选择何时调用 observe。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { WorldEventLedger } from './event-ledger.ts';
import { timePhaseTransitions, timePhases, type TimePhases } from './time-phases.ts';

interface TimeObserverFile {
    version: 2;
    phases: TimePhases;
    observedAt: string;
}

interface LegacyTimeObserverFile { version: 1; phases: TimePhases }
type LoadedTimeObserverFile = Partial<TimeObserverFile> | Partial<LegacyTimeObserverFile>;

function validPhases(value: unknown): value is TimePhases {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const phases = value as Partial<TimePhases>;
    return ['night', 'morning', 'noon', 'afternoon', 'evening', 'late-night'].includes(phases.dayPhase ?? '')
        && ['weekday', 'weekend'].includes(phases.weekPhase ?? '')
        && ['early', 'middle', 'late'].includes(phases.monthPhase ?? '')
        && ['spring', 'summer', 'autumn', 'winter'].includes(phases.season ?? '');
}

export interface TimeObserver {
    phases(): TimePhases;
    /** 第一次观察只建立基线；之后只把真正变化的阶段写入事件账。 */
    observe(at: Date): number;
}

export function readTimeObserver(path: string, initialAt: Date, ledger: WorldEventLedger, log: (message: string) => void = () => undefined): TimeObserver {
    const initial = timePhases(initialAt);
    const loaded = readJsonOr<LoadedTimeObserverFile>(path, {}, log, {
        validate: (value): value is TimeObserverFile | LegacyTimeObserverFile => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
            const state = value as { version?: unknown; phases?: unknown; observedAt?: unknown };
            return (state.version === 1 || state.version === 2) && validPhases(state.phases)
                && (state.version === 1 || (typeof state.observedAt === 'string' && Number.isFinite(Date.parse(state.observedAt))));
        },
        invalid: 'throw', label: '世界时钟观察器',
    });
    let current = (loaded.version === 1 || loaded.version === 2) && validPhases(loaded.phases) ? loaded.phases : initial;
    let observedAt = loaded.version === 2 && typeof loaded.observedAt === 'string' ? new Date(loaded.observedAt) : initialAt;
    const save = () => writeJsonAtomic(path, { version: 2, phases: current, observedAt: observedAt.toISOString() } satisfies TimeObserverFile);
    if (loaded.version !== 2) save();
    return {
        phases: () => current,
        observe: at => {
            if (!Number.isFinite(at.getTime())) throw new RangeError('世界时钟的时间不合法');
            // 系统时钟回拨时不倒着制造事件：以新的现实时间重新建立连续基线。
            if (at < observedAt) {
                current = timePhases(at);
                observedAt = at;
                save();
                return 0;
            }
            const events = timePhaseTransitions(observedAt, at);
            const next = timePhases(at);
            if (events.length === 0) {
                observedAt = at;
                if (current.dayPhase !== next.dayPhase || current.weekPhase !== next.weekPhase
                    || current.monthPhase !== next.monthPhase || current.season !== next.season) current = next;
                save();
                return 0;
            }
            // 先落事件再更新观察器状态，避免崩溃后漏掉阶段变化；事件账按 ID 幂等。
            const added = ledger.append(events);
            current = next;
            observedAt = at;
            save();
            return added;
        },
    };
}

