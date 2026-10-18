export type NetEvent = { kind: 'down'; bad: number; minutes: number } | { kind: 'up'; minutes: number };

export function createNetWatch(options?: { window?: number; badMin?: number; goodRun?: number; everyMs?: number }): {
    push(up: boolean, now?: number): NetEvent | undefined;
    readonly alerted: boolean;
};
