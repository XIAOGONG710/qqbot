import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { ExternalPlatform } from './external-platforms.ts';

export type ExternalDraftStatus = 'pending' | 'approved' | 'rejected' | 'published' | 'failed';
export interface ExternalDraftAudit { at: string; status: ExternalDraftStatus; note?: string }
export interface ExternalDraft {
    id: string;
    platform: ExternalPlatform;
    title: string;
    body: string;
    media: string[];
    createdAt: string;
    updatedAt: string;
    status: ExternalDraftStatus;
    source: 'dsh' | 'qq' | 'manual' | 'adapter';
    audit: ExternalDraftAudit[];
}
export interface ExternalDraftSummary {
    total: number;
    pending: number;
    approved: number;
    failed: number;
    byPlatform: Record<ExternalPlatform, number>;
    lastAt?: string;
}
export interface ExternalDraftStore {
    create(input: { platform: ExternalPlatform; title: string; body: string; media?: readonly string[]; source?: ExternalDraft['source']; at?: Date }): ExternalDraft;
    list(options?: { platform?: ExternalPlatform; status?: ExternalDraftStatus; limit?: number }): ExternalDraft[];
    updateStatus(id: string, status: ExternalDraftStatus, note?: string, at?: Date): ExternalDraft | undefined;
    summary(): ExternalDraftSummary;
}

interface DraftFile { version: 1; drafts: ExternalDraft[] }
const PLATFORMS: readonly ExternalPlatform[] = ['tieba', 'douyin', 'xiaohongshu'];
const STATUSES: readonly ExternalDraftStatus[] = ['pending', 'approved', 'rejected', 'published', 'failed'];
const MAX_DRAFTS = 500;
const MAX_TITLE = 120;
const MAX_BODY = 10_000;
const MAX_MEDIA = 8;
const isPlatform = (value: unknown): value is ExternalPlatform => PLATFORMS.includes(value as ExternalPlatform);
const isStatus = (value: unknown): value is ExternalDraftStatus => STATUSES.includes(value as ExternalDraftStatus);
const isSafeMediaRef = (value: string): boolean => value.length <= 500 && (value.startsWith('https://') || /^media:[a-zA-Z0-9._/-]+$/.test(value));
function validAudit(value: unknown): value is ExternalDraftAudit {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ExternalDraftAudit>;
    return typeof item.at === 'string' && isStatus(item.status) && (item.note === undefined || typeof item.note === 'string');
}
function validDraft(value: unknown): value is ExternalDraft {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ExternalDraft>;
    return typeof item.id === 'string' && /^[a-z0-9-]{8,80}$/.test(item.id)
        && isPlatform(item.platform)
        && typeof item.title === 'string' && item.title.length <= MAX_TITLE
        && typeof item.body === 'string' && item.body.length <= MAX_BODY
        && Array.isArray(item.media) && item.media.length <= MAX_MEDIA && item.media.every(media => typeof media === 'string' && isSafeMediaRef(media))
        && typeof item.createdAt === 'string' && typeof item.updatedAt === 'string'
        && isStatus(item.status)
        && (item.source === 'dsh' || item.source === 'qq' || item.source === 'manual' || item.source === 'adapter')
        && Array.isArray(item.audit) && item.audit.length > 0 && item.audit.every(validAudit);
}
function validFile(value: unknown): value is DraftFile {
    if (!value || typeof value !== 'object') return false;
    const file = value as Partial<DraftFile>;
    return file.version === 1 && Array.isArray(file.drafts) && file.drafts.length <= MAX_DRAFTS && file.drafts.every(validDraft);
}
function text(value: string, max: number, label: string): string {
    const result = value.trim();
    if (!result) throw new Error(`外部平台草稿${label}不能为空`);
    if (result.length > max) throw new Error(`外部平台草稿${label}不能超过 ${max} 字`);
    return result;
}
function transitionAllowed(from: ExternalDraftStatus, to: ExternalDraftStatus): boolean {
    if (from === to) return true;
    return from === 'pending' && (to === 'approved' || to === 'rejected')
        || from === 'approved' && (to === 'published' || to === 'failed')
        || from === 'failed' && to === 'approved';
}

export function createExternalDraftStore(options: { dir: string; log?: (message: string) => void }): ExternalDraftStore {
    mkdirSync(options.dir, { recursive: true });
    const path = join(options.dir, 'drafts.json');
    let file = readJsonOr<DraftFile>(path, { version: 1, drafts: [] }, options.log, { validate: validFile, label: '外部平台草稿' });
    const save = () => writeJsonAtomic(path, file);
    return {
        create(input) {
            if (!isPlatform(input.platform)) throw new Error('不支持的外部平台');
            const title = text(input.title, MAX_TITLE, '标题');
            const body = text(input.body, MAX_BODY, '正文');
            const media = [...new Set((input.media ?? []).map(item => item.trim()).filter(Boolean))];
            if (media.length > MAX_MEDIA || media.some(item => !isSafeMediaRef(item))) throw new Error('外部平台草稿素材只允许 https 链接或 media: 引用');
            const at = (input.at ?? new Date()).toISOString();
            const draft: ExternalDraft = { id: `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`, platform: input.platform, title, body, media, createdAt: at, updatedAt: at, status: 'pending', source: input.source ?? 'manual', audit: [{ at, status: 'pending' }] };
            file.drafts = [...file.drafts, draft].slice(-MAX_DRAFTS);
            save();
            return draft;
        },
        list(filter = {}) {
            const limit = Math.max(1, Math.min(100, Math.floor(filter.limit ?? 50)));
            return file.drafts.filter(item => (!filter.platform || item.platform === filter.platform) && (!filter.status || item.status === filter.status)).slice(-limit).reverse();
        },
        updateStatus(id, status, note, at = new Date()) {
            if (!isStatus(status)) throw new Error('不支持的外部平台草稿状态');
            const draft = file.drafts.find(item => item.id === id);
            if (!draft) return undefined;
            if (!transitionAllowed(draft.status, status)) throw new Error(`外部平台草稿不能从 ${draft.status} 变为 ${status}`);
            const cleanNote = note?.trim();
            if (cleanNote && cleanNote.length > 240) throw new Error('外部平台草稿备注不能超过 240 字');
            const when = at.toISOString();
            draft.status = status;
            draft.updatedAt = when;
            draft.audit.push({ at: when, status, ...(cleanNote ? { note: cleanNote } : {}) });
            save();
            return draft;
        },
        summary() {
            const byPlatform = { tieba: 0, douyin: 0, xiaohongshu: 0 } satisfies Record<ExternalPlatform, number>;
            for (const draft of file.drafts) byPlatform[draft.platform]++;
            const lastAt = file.drafts.map(item => item.updatedAt).sort().at(-1);
            return { total: file.drafts.length, pending: file.drafts.filter(item => item.status === 'pending').length, approved: file.drafts.filter(item => item.status === 'approved').length, failed: file.drafts.filter(item => item.status === 'failed').length, byPlatform, ...(lastAt ? { lastAt } : {}) };
        },
    };
}
