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
function isSafeMediaRef(value: string): boolean {
    if (value.length > 500) return false;
    // media: 是素材仓库里的逻辑 ID，不是本地路径。每段必须以字母或数字开头，
    // 因而不能出现绝对路径、隐藏目录、`.` / `..` 或编码后的路径穿越。
    if (/^media:[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/.test(value)) return true;
    if (!value.startsWith('https://')) return false;
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        for (const key of url.searchParams.keys()) if (/token|secret|cookie|auth|signature|sig|access.?key|api.?key/i.test(key)) return false;
        return true;
    } catch {
        return false;
    }
}
function validAudit(value: unknown): value is ExternalDraftAudit {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ExternalDraftAudit>;
    return typeof item.at === 'string' && isStatus(item.status) && (item.note === undefined || (typeof item.note === 'string' && item.note.length <= 240));
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
    return from === 'pending' && (to === 'approved' || to === 'rejected')
        || from === 'approved' && (to === 'published' || to === 'failed')
        || from === 'failed' && to === 'approved';
}

export function createExternalDraftStore(options: { dir: string; log?: (message: string) => void; canDraft?: (platform: ExternalPlatform) => boolean }): ExternalDraftStore {
    mkdirSync(options.dir, { recursive: true });
    const path = join(options.dir, 'drafts.json');
    let file = readJsonOr<DraftFile>(path, { version: 1, drafts: [] }, options.log, { validate: validFile, label: '外部平台草稿' });
    const save = (next: DraftFile) => {
        // 先落盘、成功后再替换内存；写盘失败时当前进程不能假装状态已经推进。
        writeJsonAtomic(path, next);
        file = next;
    };
    return {
        create(input) {
            if (!isPlatform(input.platform)) throw new Error('不支持的外部平台');
            if (options.canDraft && !options.canDraft(input.platform)) throw new Error('该外部平台当前已关闭，不能创建草稿');
            const title = text(input.title, MAX_TITLE, '标题');
            const body = text(input.body, MAX_BODY, '正文');
            const media = [...new Set((input.media ?? []).map(item => item.trim()).filter(Boolean))];
            if (media.length > MAX_MEDIA || media.some(item => !isSafeMediaRef(item))) throw new Error('外部平台草稿素材只允许 https 链接或 media: 引用');
            const at = (input.at ?? new Date()).toISOString();
            const draft: ExternalDraft = { id: `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`, platform: input.platform, title, body, media, createdAt: at, updatedAt: at, status: 'pending', source: input.source ?? 'manual', audit: [{ at, status: 'pending' }] };
            save({ version: 1, drafts: [...file.drafts, draft].slice(-MAX_DRAFTS) });
            return draft;
        },
        list(filter = {}) {
            const requestedLimit = filter.limit ?? 50;
            // 控制台参数可能来自解析失败的输入；NaN 会让 slice(-NaN) 退化成 slice(0)，
            // 绕过默认的分页上限。无效数字按默认页大小处理，避免一次返回整个队列。
            const limit = Number.isFinite(requestedLimit)
                ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
                : 50;
            return file.drafts.filter(item => (!filter.platform || item.platform === filter.platform) && (!filter.status || item.status === filter.status)).slice(-limit).reverse();
        },
        updateStatus(id, status, note, at = new Date()) {
            if (!isStatus(status)) throw new Error('不支持的外部平台草稿状态');
            const draft = file.drafts.find(item => item.id === id);
            if (!draft) return undefined;
            // 适配器可能在网络结果不确定时重试状态回写；同状态必须是真正的幂等操作，
            // 不能反复改 updatedAt 或追加审计记录。
            if (draft.status === status) return draft;
            if (!transitionAllowed(draft.status, status)) throw new Error(`外部平台草稿不能从 ${draft.status} 变为 ${status}`);
            const cleanNote = note?.trim();
            if (cleanNote && cleanNote.length > 240) throw new Error('外部平台草稿备注不能超过 240 字');
            const when = at.toISOString();
            const updated: ExternalDraft = {
                ...draft,
                status,
                updatedAt: when,
                audit: [...draft.audit, { at: when, status, ...(cleanNote ? { note: cleanNote } : {}) }],
            };
            save({ version: 1, drafts: file.drafts.map(item => item.id === id ? updated : item) });
            return updated;
        },
        summary() {
            const byPlatform = { tieba: 0, douyin: 0, xiaohongshu: 0 } satisfies Record<ExternalPlatform, number>;
            for (const draft of file.drafts) byPlatform[draft.platform]++;
            const lastAt = file.drafts.map(item => item.updatedAt).sort().at(-1);
            return { total: file.drafts.length, pending: file.drafts.filter(item => item.status === 'pending').length, approved: file.drafts.filter(item => item.status === 'approved').length, failed: file.drafts.filter(item => item.status === 'failed').length, byPlatform, ...(lastAt ? { lastAt } : {}) };
        },
    };
}
