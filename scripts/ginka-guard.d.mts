export function privateReason(path: string): string | undefined;
export function isPrivateTask(task: unknown): boolean;
export function scrubQueue<T extends { tasks?: unknown[] } | undefined>(queue: T): { queue: T; removed: number };
