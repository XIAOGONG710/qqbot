import type { JudgmentAsk, JudgmentLine, JudgmentMessage } from './semantic-judgment.mjs';

export interface Relevance { keep: number[]; uncertainty: number; asked?: number }
export type RelevanceFallback = 'empty' | 'timeout' | 'error' | 'unparsable' | 'uncertain';
export interface RelevanceResult { relevance?: Relevance; fallback?: RelevanceFallback }

export const RELEVANCE_TIMEOUT_MS: number;
export const RELEVANCE_MAX_TOKENS: number;
export const RELEVANCE_MAX_UNCERTAINTY: number;
export const RELEVANCE_CANDIDATES_MAX: number;
export const RELEVANCE_CANDIDATE_CHARS: number;
export const RELEVANCE_SYSTEM: string;
export function relevanceCandidates(lines: readonly string[]): string[];
export function relevanceMessages(conversation: readonly JudgmentLine[], candidates: readonly string[]): JudgmentMessage[];
export function parseRelevance(raw: unknown, count: number): Relevance | undefined;
export function usableRelevance(relevance: Relevance | undefined): relevance is Relevance;
export function judgeRelevance(input: { conversation: readonly JudgmentLine[]; candidates: readonly string[]; ask: JudgmentAsk; timeoutMs?: number }): Promise<RelevanceResult>;
export function applyRelevance<T>(items: readonly T[], result: RelevanceResult | undefined): T[];
export function relevanceLogLine(result: RelevanceResult, count: number): string;
