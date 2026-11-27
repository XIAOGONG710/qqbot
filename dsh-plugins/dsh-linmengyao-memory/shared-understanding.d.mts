export const UNDERSTANDING_EXPORT: string;
export const UNDERSTANDING_MAX_AGE: number;
export function understandingKey(text: string): string;
export function isAmbiguousAcknowledgement(text: string): boolean;
export const acknowledgementHypotheses: readonly string[];
export type SharedUnderstanding = { id: string; original: string; at: number; hypotheses: string[] } & (
    { status: 'tentative'; revision?: undefined } |
    { status: 'corrected'; revision: { id: string; at: number; evidence: string; interpretation: string } }
);
export function readSharedUnderstanding(file: string, strict?: boolean): SharedUnderstanding[];
export function sharedUnderstandingLine(file: string, query: string, now?: number): string;
