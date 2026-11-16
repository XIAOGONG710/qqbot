// 时间观察器：把世界时钟的阶段变化写入事件账。
// 这是感知器，不是定时器，也不决定任何主动行为；宿主以后自行选择何时调用 observe。

import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { WorldEventLedger } from './event-ledger.ts';
import { timePhaseEvents, timePhases, type TimePhases } from './time-phases.ts';

interface TimeObserverFile {
    version: 1;
    phases: TimePhases;
}

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
    const loaded = readJsonOr<Partial<TimeObserverFile>>(path, {}, log, {
        validate: (value): value is TimeObserverFile => Boolean(value && typeof value === 'object'
            && (value as Partial<TimeObserverFile>).version === 1 && validPhases((value as Partial<TimeObserverFile>).phases)),
        invalid: 'throw', label: '世界时钟观察器',
    });
    let current = loaded.version === 1 && validPhases(loaded.phases) ? loaded.phases : initial;
    if (loaded.version !== 1) writeJsonAtomic(path, { version: 1, phases: current } satisfies TimeObserverFile);
    return {
        phases: () => current,
        observe: at => {
            const events = timePhaseEvents(current, at);
            const next = timePhases(at);
            if (events.length === 0) return 0;
            // 先落事件再更新观察器状态，避免崩溃后漏掉阶段变化；事件账按 ID 幂等。
            const added = ledger.append(events);
            writeJsonAtomic(path, { version: 1, phases: next } satisfies TimeObserverFile);
            current = next;
            return added;
        },
    };
}

