export type MemoryThresholdReader = 'qq' | 'dsh';
export interface MemoryThresholdSpec { value: number; min: number; max: number; readers: readonly MemoryThresholdReader[]; where: string; note: string }
export type MemoryThresholdKey =
    | 'clearDays' | 'vagueDays' | 'crossWindowMs' | 'crossLineChars' | 'crossTailBytes' | 'desktopKeepMs' | 'desktopTextChars' | 'inboxMaxAgeMs'
    | 'recallTimeoutMs' | 'feelingCoarseAfterDays'
    | 'rawMessages' | 'maxRecalled' | 'sharedRecalled' | 'personRecalled' | 'todayOthers' | 'sameThingRecalled' | 'recallTokens' | 'dayRecallTokens'
    | 'maxQueryChars' | 'recalledLineChars' | 'recallBreakerTimeouts' | 'recallBreakerMs' | 'memoryTimeoutMs' | 'desktopMaxTurns'
    | 'notebookMaxAttempts' | 'notebookMaxAgeMs'
    | 'desktopPick' | 'desktopMaxChars' | 'desktopRecallTokens' | 'bankListTimeoutMs' | 'qqRecentLines';
export type MemoryThresholds = Readonly<Record<MemoryThresholdKey, number>>;
export interface MemoryThresholdsResult { values: MemoryThresholds; issue?: string }

export const MEMORY_THRESHOLD_SPECS: Readonly<Record<MemoryThresholdKey, MemoryThresholdSpec>>;
export const MEMORY_THRESHOLD_KEYS: readonly MemoryThresholdKey[];
export const MEMORY_THRESHOLD_DEFAULTS: MemoryThresholds;
export const SHARED_MEMORY_THRESHOLD_KEYS: readonly MemoryThresholdKey[];
export function resolveMemoryThresholds(overrides: unknown): MemoryThresholdsResult;
export function loadMemoryThresholds(file: string | undefined, read?: (file: string, encoding: 'utf8') => string): MemoryThresholdsResult;
export function memoryThresholdsLogLine(result: MemoryThresholdsResult): string;
