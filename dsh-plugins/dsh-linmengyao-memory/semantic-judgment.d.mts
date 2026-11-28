export type JudgmentCategory = 'care' | 'banter' | 'closing' | 'refusal' | 'correction' | 'none' | 'unclear';
export interface JudgmentLine { role: 'user' | 'assistant'; content: string }
export interface JudgmentEvidence { line: number; speaker: 'him' | 'her'; quote: string }
export interface Judgment { category: JudgmentCategory; evidence: JudgmentEvidence[]; uncertainty: number }
export type JudgmentFallback = 'empty' | 'timeout' | 'error' | 'unparsable' | 'uncertain';
export interface JudgmentResult { judgment?: Judgment; fallback?: JudgmentFallback }
export interface JudgmentMessage { role: 'system' | 'user'; content: string }
export type JudgmentAsk = (messages: JudgmentMessage[]) => Promise<string>;

export const JUDGMENT_CATEGORIES: readonly JudgmentCategory[];
export const JUDGMENT_LABELS: Record<JudgmentCategory, string>;
export const JUDGMENT_INTENTS: readonly JudgmentCategory[];
export const JUDGMENT_CONTEXT: number;
export const JUDGMENT_LINE_MAX: number;
export const JUDGMENT_QUOTE_MAX: number;
export const JUDGMENT_EVIDENCE_MAX: number;
export const JUDGMENT_TIMEOUT_MS: number;
export const JUDGMENT_MAX_TOKENS: number;
export const JUDGMENT_MAX_UNCERTAINTY: number;
export const JUDGMENT_SYSTEM: string;
export function judgmentConversation(messages: readonly { role: string; content?: unknown }[] | undefined): JudgmentLine[];
export function latestLines(conversation: readonly JudgmentLine[]): number[];
export function judgmentMessages(conversation: readonly JudgmentLine[]): JudgmentMessage[];
export function parseJudgment(raw: unknown, conversation: readonly JudgmentLine[]): Judgment | undefined;
export function usableJudgment(judgment: Judgment | undefined): judgment is Judgment;
export function judgeTurn(input: { conversation: readonly JudgmentLine[]; ask: JudgmentAsk; timeoutMs?: number }): Promise<JudgmentResult>;
export function judgmentLine(judgment: Judgment | undefined): string;
export function reportedSpeech(conversation: readonly JudgmentLine[]): boolean;
export function judgmentLogLine(result: JudgmentResult, conversation: readonly JudgmentLine[]): string;
export function createJudgmentAsk(options?: {
    key?: string; baseUrl?: string; model?: string; extraBody?: Record<string, unknown>;
    fetcher?: (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
    timeoutMs?: number;
}): JudgmentAsk | undefined;
