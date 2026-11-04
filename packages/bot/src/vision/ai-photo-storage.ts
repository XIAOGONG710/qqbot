// AI 照片草稿存储审计与清理预览（ADR 0246）。本模块只读，不执行删除。

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FILE_NAME = /^([a-f0-9]{12})\.(jpg|png|webp)$/;
const ENTRY_ID = /^[a-f0-9]{12}$/;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;
const DEFAULT_REJECTED_RETENTION_DAYS = 30;

type StoredEntry = {
    id: string;
    file: string;
    status: 'pending_review' | 'approved' | 'rejected';
    createdAt: string;
    reviewedAt?: string;
};

export type AiPhotoStorageIssueCode =
    | 'index_invalid'
    | 'index_symlink'
    | 'files_not_directory'
    | 'files_symlink'
    | 'entry_file_invalid'
    | 'entry_file_missing'
    | 'entry_file_symlink'
    | 'entry_file_not_regular'
    | 'orphan_file'
    | 'unexpected_file';

export interface AiPhotoStorageIssue {
    code: AiPhotoStorageIssueCode;
    /** 只给内容哈希式编号；不返回绝对路径、提示词或上下文字段。 */
    id?: string;
    /** 只在文件名通过固定格式校验时返回。 */
    file?: string;
}

export interface AiPhotoCleanupCandidate {
    kind: 'rejected_entry' | 'orphan_file';
    id: string;
    file: string;
    /** rejected_entry 表示将来应用时须同时移除索引项和文件；本模块不会应用。 */
    reviewedAt?: string;
}

export interface AiPhotoStorageReport {
    indexPresent: boolean;
    entries: number;
    files: number;
    issues: AiPhotoStorageIssue[];
    cleanup: AiPhotoCleanupCandidate[];
    dryRun: true;
}

const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function parseIndex(path: string): StoredEntry[] | undefined {
    try {
        const info = statSync(path);
        if (!info.isFile() || info.size <= 0 || info.size > MAX_INDEX_BYTES) return undefined;
        const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; entries?: unknown };
        if (value.version !== 1 || !Array.isArray(value.entries)) return undefined;
        const entries: StoredEntry[] = [];
        for (const raw of value.entries) {
            if (!raw || typeof raw !== 'object') return undefined;
            const entry = raw as Partial<StoredEntry>;
            if (typeof entry.id !== 'string' || !ENTRY_ID.test(entry.id)
                || typeof entry.file !== 'string'
                || !['pending_review', 'approved', 'rejected'].includes(String(entry.status))
                || !validDate(entry.createdAt)
                || (entry.reviewedAt !== undefined && !validDate(entry.reviewedAt))) return undefined;
            entries.push(entry as StoredEntry);
        }
        return entries;
    } catch {
        return undefined;
    }
}

const olderThan = (value: string | undefined, cutoff: number) => value !== undefined && Date.parse(value) <= cutoff;

/**
 * 只读审计。清理清单只是预览：调用者不能从这里获得 apply/delete 能力。
 * 符号链接和非固定哈希文件名只报告，绝不会列入可清理清单。
 */
export function auditAiPhotoStorage(dir: string, options: { now?: Date; rejectedRetentionDays?: number } = {}): AiPhotoStorageReport {
    const indexPath = join(dir, 'index.json');
    const filesDir = join(dir, 'files');
    const indexPresent = existsSync(indexPath);
    const issues: AiPhotoStorageIssue[] = [];
    const cleanup: AiPhotoCleanupCandidate[] = [];
    let indexSymlink = false;
    if (indexPresent) {
        try { indexSymlink = lstatSync(indexPath).isSymbolicLink(); } catch { /* parseIndex 会保守失败 */ }
    }
    const entries = indexPresent && !indexSymlink ? parseIndex(indexPath) : indexPresent ? undefined : [];
    if (indexSymlink) issues.push({ code: 'index_symlink' });
    else if (indexPresent && entries === undefined) issues.push({ code: 'index_invalid' });

    const safeEntries = entries ?? [];
    const referenced = new Set<string>();
    let files = 0;
    let canReadFiles = false;
    if (existsSync(filesDir)) {
        try {
            const info = lstatSync(filesDir);
            if (info.isSymbolicLink()) issues.push({ code: 'files_symlink' });
            else if (!info.isDirectory()) issues.push({ code: 'files_not_directory' });
            else canReadFiles = true;
        } catch {
            issues.push({ code: 'files_not_directory' });
        }
    }

    for (const entry of safeEntries) {
        const match = FILE_NAME.exec(entry.file);
        if (!match || match[1] !== entry.id) {
            issues.push({ code: 'entry_file_invalid', id: entry.id });
            continue;
        }
        referenced.add(entry.file);
        if (!canReadFiles || !existsSync(join(filesDir, entry.file))) {
            issues.push({ code: 'entry_file_missing', id: entry.id, file: entry.file });
            continue;
        }
        const fileInfo = lstatSync(join(filesDir, entry.file));
        if (fileInfo.isSymbolicLink()) issues.push({ code: 'entry_file_symlink', id: entry.id, file: entry.file });
        else if (!fileInfo.isFile()) issues.push({ code: 'entry_file_not_regular', id: entry.id, file: entry.file });
    }

    if (canReadFiles) {
        for (const item of readdirSync(filesDir, { withFileTypes: true })) {
            files += 1;
            const match = FILE_NAME.exec(item.name);
            if (!match) {
                issues.push({ code: 'unexpected_file' });
                continue;
            }
            if (referenced.has(item.name)) continue;
            const id = match[1]!;
            issues.push({ code: 'orphan_file', id, file: item.name });
            // 只把普通文件列入预览；符号链接和目录一律不提供清理候选。
            if (item.isFile() && !item.isSymbolicLink()) cleanup.push({ kind: 'orphan_file', id, file: item.name });
        }
    }

    const retentionDays = options.rejectedRetentionDays ?? DEFAULT_REJECTED_RETENTION_DAYS;
    const safeRetention = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3650
        ? retentionDays : DEFAULT_REJECTED_RETENTION_DAYS;
    const cutoff = (options.now ?? new Date()).getTime() - safeRetention * 24 * 60 * 60_000;
    for (const entry of safeEntries) {
        if (entry.status !== 'rejected' || !olderThan(entry.reviewedAt ?? entry.createdAt, cutoff)) continue;
        const match = FILE_NAME.exec(entry.file);
        if (!match || match[1] !== entry.id) continue;
        // 即使文件已丢失，仍可预览“移除陈旧索引项”；真正应用必须由未来单独的确认流程完成。
        const path = join(filesDir, entry.file);
        const regular = existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile();
        if (!existsSync(path) || regular) cleanup.push({ kind: 'rejected_entry', id: entry.id, file: entry.file, ...(entry.reviewedAt ? { reviewedAt: entry.reviewedAt } : {}) });
    }

    return { indexPresent, entries: safeEntries.length, files, issues, cleanup, dryRun: true };
}

