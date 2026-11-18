import type { Module } from '../interpreter/interpreter.ts';

type SyncedJobs = Partial<Record<'weeklyReport' | 'watching' | 'feed' | 'memes', () => void>>;

export function syncedJobsModule(jobs: SyncedJobs): Module {
    const halfHour = 30 * 60_000;
    return {
        id: 'synced-jobs',
        schedules: [
            ...(jobs.weeklyReport ? [{ every: 2 * halfHour, run: jobs.weeklyReport }] : []),
            ...(jobs.watching ? [{ every: halfHour, run: jobs.watching }] : []),
            ...(jobs.feed ? [{ every: halfHour, run: jobs.feed, runOnStart: true }] : []),
            ...(jobs.memes ? [{ every: halfHour, run: jobs.memes }] : []),
        ],
    };
}
