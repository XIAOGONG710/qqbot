import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const PHOTO_INDEX_LOCK_FILE = 'index.coordination.sqlite';
export const PHOTO_INDEX_BUSY_MS = 50;

/** Only lock acquisition errors are wrapped; callback failures retain their original identity. */
export class PhotoIndexLockError extends Error {
    readonly retryable: boolean;
    constructor(retryable = false) {
        super(retryable ? '照片索引协调锁暂时繁忙，请稍后重试' : '照片索引协调锁不可用；原文件未重建，请修复后重试');
        this.name = 'PhotoIndexLockError';
        this.retryable = retryable;
    }
}

function acquisitionError(error: unknown): PhotoIndexLockError {
    const code = (error as { errcode?: unknown } | null)?.errcode;
    return new PhotoIndexLockError(typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6));
}

/**
 * SQLite coordinates writers only: JSON remains the authority, including after a process crash.
 * Work must be synchronous and must reread JSON under this lock before applying its operation delta.
 */
export function withPhotoIndexLock<T>(dir: string, work: () => T & (T extends PromiseLike<unknown> ? never : unknown), onReleaseError?: () => void): T;
export function withPhotoIndexLock<T>(dir: string, work: () => T, onReleaseError?: () => void): T {
    let database: DatabaseSync | undefined;
    let acquired = false;
    try {
        try {
            mkdirSync(dir, { recursive: true });
            database = new DatabaseSync(join(dir, PHOTO_INDEX_LOCK_FILE), { timeout: PHOTO_INDEX_BUSY_MS });
            database.exec('BEGIN IMMEDIATE');
            acquired = true;
        } catch (error) { throw acquisitionError(error); }
        const result = work();
        if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
            // Do not let a mistakenly async callback retain the OS lock or cause an unhandled rejection.
            void Promise.resolve(result).catch(() => {});
            throw new TypeError('照片索引协调锁只接受同步操作');
        }
        return result;
    } finally {
        let releaseFailed = false;
        // No SQLite data is changed. ROLLBACK releases the mutex without creating a second commit point.
        if (acquired) { try { database!.exec('ROLLBACK'); } catch { releaseFailed = true; } }
        if (database) { try { database.close(); } catch { releaseFailed = true; } }
        // JSON may already be published: cleanup/logging failures cannot turn success into a replayable failure.
        if (releaseFailed) { try { onReleaseError?.(); } catch { /* Preserve the callback's result or original exception. */ } }
    }
}
