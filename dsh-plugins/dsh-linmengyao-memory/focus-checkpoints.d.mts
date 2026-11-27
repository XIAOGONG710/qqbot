export const FOCUS_CHECKPOINT_FILE: string;
type Span = { start: Date; end: Date };
export function desktopFocusBusy(file: string, fallback: readonly Span[], now: number): Span[];
export function focusCheckpoint(file: string, args: { action: string; taskId?: string; operationId?: string; next?: string; claimId?: string }, now?: number): {
    taskId?: string; status: string; next?: string; acquired?: boolean;
};
