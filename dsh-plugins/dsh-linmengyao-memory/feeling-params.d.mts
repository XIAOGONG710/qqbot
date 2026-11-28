export type FeelingParamReader = 'qq' | 'dsh';
export interface FeelingParamSpec { value: number; min: number; max: number; integer: boolean; readers: readonly FeelingParamReader[]; where: string; note: string }
export type FeelingParamKey =
    | 'feelingsStaleMs'
    | 'joyHalfLifeH' | 'reliefHalfLifeH' | 'worryHalfLifeH' | 'sadHalfLifeH' | 'annoyedHalfLifeH' | 'tiredHalfLifeH' | 'halfLivesKept' | 'historyWindowMs' | 'silentAfterMs'
    | 'smallAmplitude' | 'mediumAmplitude' | 'bigAmplitude' | 'faintAt' | 'clearAt' | 'strongAt' | 'kindCap' | 'warmAffectReplies'
    | 'recoveryHalfLifeH' | 'recoveryWindowMs'
    | 'grievanceGapMs' | 'grievanceRounds' | 'grievanceWindowMs' | 'burstGapMs' | 'ignoredGapMs' | 'ignoredMaxMs';
export type FeelingParams = Readonly<Record<FeelingParamKey, number>>;
export interface FeelingParamsResult { values: FeelingParams; issue?: string }

export const FEELING_PARAM_SPECS: Readonly<Record<FeelingParamKey, FeelingParamSpec>>;
export const FEELING_PARAM_KEYS: readonly FeelingParamKey[];
export const FEELING_PARAM_DEFAULTS: FeelingParams;
export const SHARED_FEELING_PARAM_KEYS: readonly FeelingParamKey[];
export function resolveFeelingParams(overrides: unknown): FeelingParamsResult;
export function loadFeelingParams(file: string | undefined, read?: (file: string, encoding: 'utf8') => string): FeelingParamsResult;
export function feelingParamsLogLine(result: FeelingParamsResult): string;
