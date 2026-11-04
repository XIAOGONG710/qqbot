import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import type { ExternalPlatform } from './external-platforms.ts';

export type ExternalDraftStatus = 'pending' | 'approved' | 'rejected' | 'publishing' | 'published' | 'failed';
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
    /** A stable key that an official adapter must reuse for every publish attempt. */
    publishRequestId?: string;
    audit: ExternalDraftAudit[];
}
export interface ExternalDraftSummary {
    total: number;
    pending: number;
    approved: number;
    /** Remote outcome may be unknown; this needs reconciliation and must not be retried automatically. */
    publishing: number;
    failed: number;
    byPlatform: Record<ExternalPlatform, number>;
    lastAt?: string;
}
export interface ExternalDraftStore {
    create(input: { platform: ExternalPlatform; title: string; body: string; media?: readonly string[]; source?: ExternalDraft['source']; at?: Date }): ExternalDraft;
    list(options?: { platform?: ExternalPlatform; status?: ExternalDraftStatus; limit?: number }): ExternalDraft[];
    /** Atomically reserves an approved draft before any external side effect. `started=false` requires manual reconciliation, not another publish call. */
    beginPublish(id: string, platform: ExternalPlatform, at?: Date): { draft: ExternalDraft; started: boolean } | undefined;
    updateStatus(id: string, status: ExternalDraftStatus, note?: string, at?: Date): ExternalDraft | undefined;
    summary(): ExternalDraftSummary;
}

interface DraftFile { version: 1; drafts: ExternalDraft[] }
const PLATFORMS: readonly ExternalPlatform[] = ['tieba', 'douyin', 'xiaohongshu'];
const STATUSES: readonly ExternalDraftStatus[] = ['pending', 'approved', 'rejected', 'publishing', 'published', 'failed'];
export const MAX_EXTERNAL_DRAFTS = 500;
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
    return typeof item.at === 'string' && Number.isFinite(Date.parse(item.at))
        && isStatus(item.status) && (item.note === undefined || (typeof item.note === 'string' && item.note.length <= 240));
}
function validDraft(value: unknown): value is ExternalDraft {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ExternalDraft>;
    const structurallyValid = typeof item.id === 'string' && /^[a-z0-9-]{8,80}$/.test(item.id)
        && isPlatform(item.platform)
        && typeof item.title === 'string' && Boolean(item.title.trim()) && item.title.length <= MAX_TITLE
        && typeof item.body === 'string' && Boolean(item.body.trim()) && item.body.length <= MAX_BODY
        && Array.isArray(item.media) && item.media.length <= MAX_MEDIA && item.media.every(media => typeof media === 'string' && isSafeMediaRef(media))
        && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
        && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
        && isStatus(item.status)
        && (item.source === 'dsh' || item.source === 'qq' || item.source === 'manual' || item.source === 'adapter')
        && (item.publishRequestId === undefined || (typeof item.publishRequestId === 'string' && /^publish-(?:tieba|douyin|xiaohongshu)-[a-z0-9-]{8,80}$/.test(item.publishRequestId)))
        && Array.isArray(item.audit) && item.audit.length > 0 && item.audit.every(validAudit);
    if (!structurallyValid) return false;
    const audit = item.audit!;
    if (Date.parse(item.createdAt!) > Date.parse(item.updatedAt!)) return false;
    if (audit[0]!.status !== 'pending' || audit[0]!.at !== item.createdAt) return false;
    for (let index = 1; index < audit.length; index += 1) {
        const previous = audit[index - 1]!;
        const current = audit[index]!;
        if (Date.parse(previous.at) > Date.parse(current.at) || !storedTransitionAllowed(previous.status, current.status)) return false;
    }
    const last = audit.at(-1)!;
    if ((item.status === 'publishing') && !item.publishRequestId) return false;
    return last.status === item.status && last.at === item.updatedAt;
}
function validFile(value: unknown): value is DraftFile {
    if (!value || typeof value !== 'object') return false;
    const file = value as Partial<DraftFile>;
    return file.version === 1 && Array.isArray(file.drafts) && file.drafts.length <= MAX_EXTERNAL_DRAFTS && file.drafts.every(validDraft);
}
function text(value: string, max: number, label: string): string {
    const result = value.trim();
    if (!result) throw new Error(`外部平台草稿${label}不能为空`);
    if (result.length > max) throw new Error(`外部平台草稿${label}不能超过 ${max} 字`);
    return result;
}
function cloneDraft(draft: ExternalDraft): ExternalDraft {
    // 草稿箱会交给控制台和平台适配器；不能让调用方通过修改返回对象绕过状态机，
    // 或把尚未通过校验的内容带回内存并在下一次保存时污染整个队列。
    return {
        ...draft,
        media: [...draft.media],
        audit: draft.audit.map(item => ({ ...item })),
    };
}
function transitionAllowed(from: ExternalDraftStatus, to: ExternalDraftStatus): boolean {
    return from === 'pending' && (to === 'approved' || to === 'rejected')
        || from === 'approved' && to === 'publishing'
        || from === 'publishing' && (to === 'published' || to === 'failed')
        || from === 'failed' && to === 'approved';
}

/** Version 1 files created before the publishing reservation step remain readable. */
function storedTransitionAllowed(from: ExternalDraftStatus, to: ExternalDraftStatus): boolean {
    return transitionAllowed(from, to)
        || from === 'approved' && (to === 'published' || to === 'failed');
}

export function createExternalDraftStore(options: {
    dir: string;
    log?: (message: string) => void;
    canDraft?: (platform: ExternalPlatform) => boolean;
    /** 真实适配器必须同时检查官方账号授权、平台模式和本次人工确认；缺省为禁止发布。 */
    canPublish?: (platform: ExternalPlatform) => boolean;
}): ExternalDraftStore {
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
            let retained = file.drafts;
            if (retained.length >= MAX_EXTERNAL_DRAFTS) {
                // 待确认、已批准和失败待重试都仍需人工处理，不能为了新草稿静默删掉。
                // 只回收最老的已发布 / 已拒绝记录；没有可回收项时明确施加背压。
                const recyclable = retained.reduce((oldest, item, index) => {
                    if (item.status !== 'published' && item.status !== 'rejected') return oldest;
                    if (oldest < 0) return index;
                    return Date.parse(item.createdAt) < Date.parse(retained[oldest]!.createdAt) ? index : oldest;
                }, -1);
                if (recyclable < 0) throw new Error('外部平台草稿队列已满，请先处理现有草稿');
                retained = retained.filter((_, index) => index !== recyclable);
            }
            save({ version: 1, drafts: [...retained, draft] });
            return cloneDraft(draft);
        },
        list(filter = {}) {
            const requestedLimit = filter.limit ?? 50;
            // 控制台参数可能来自解析失败的输入；NaN 会让 slice(-NaN) 退化成 slice(0)，
            // 绕过默认的分页上限。无效数字按默认页大小处理，避免一次返回整个队列。
            const limit = Number.isFinite(requestedLimit)
                ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
                : 50;
            return file.drafts
                .filter(item => (!filter.platform || item.platform === filter.platform) && (!filter.status || item.status === filter.status))
                .slice(-limit)
                .reverse()
                .map(cloneDraft);
        },
        beginPublish(id, platform, at = new Date()) {
            if (!isPlatform(platform)) throw new Error('不支持的外部平台');
            const draft = file.drafts.find(item => item.id === id);
            if (!draft) return undefined;
            if (draft.platform !== platform) throw new Error('外部平台草稿与发布适配器不匹配');
            if (options.canPublish?.(platform) !== true) throw new Error('该外部平台尚未完成发布授权，不能开始发布');
            // A process that restarts after the remote request but before the local result cannot
            // know whether the platform accepted it. Never issue the side effect again here.
            if (draft.status === 'publishing') return { draft: cloneDraft(draft), started: false };
            if (draft.status !== 'approved') throw new Error(`外部平台草稿不能从 ${draft.status} 开始发布`);
            const when = at.toISOString();
            if (Date.parse(when) < Date.parse(draft.updatedAt)) throw new Error('外部平台草稿状态时间不能早于上一条审计');
            const updated: ExternalDraft = {
                ...draft,
                status: 'publishing',
                updatedAt: when,
                publishRequestId: draft.publishRequestId ?? `publish-${draft.platform}-${draft.id}`,
                audit: [...draft.audit, { at: when, status: 'publishing' }],
            };
            save({ version: 1, drafts: file.drafts.map(item => item.id === id ? updated : item) });
            return { draft: cloneDraft(updated), started: true };
        },
        updateStatus(id, status, note, at = new Date()) {
            if (!isStatus(status)) throw new Error('不支持的外部平台草稿状态');
            const draft = file.drafts.find(item => item.id === id);
            if (!draft) return undefined;
            // 适配器可能在网络结果不确定时重试状态回写；同状态必须是真正的幂等操作，
            // 不能反复改 updatedAt 或追加审计记录。
            if (draft.status === status) return cloneDraft(draft);
            if (status === 'publishing') throw new Error('开始发布必须使用 beginPublish');
            if (!transitionAllowed(draft.status, status)) throw new Error(`外部平台草稿不能从 ${draft.status} 变为 ${status}`);
            if (status === 'approved' && options.canDraft && !options.canDraft(draft.platform)) {
                throw new Error('该外部平台当前已关闭，不能批准草稿');
            }
            if (status === 'published' && options.canPublish?.(draft.platform) !== true) {
                throw new Error('该外部平台尚未完成发布授权，不能标记为已发布');
            }
            const cleanNote = note?.trim();
            if (cleanNote && cleanNote.length > 240) throw new Error('外部平台草稿备注不能超过 240 字');
            const when = at.toISOString();
            if (Date.parse(when) < Date.parse(draft.updatedAt)) throw new Error('外部平台草稿状态时间不能早于上一条审计');
            const updated: ExternalDraft = {
                ...draft,
                status,
                updatedAt: when,
                audit: [...draft.audit, { at: when, status, ...(cleanNote ? { note: cleanNote } : {}) }],
            };
            save({ version: 1, drafts: file.drafts.map(item => item.id === id ? updated : item) });
            return cloneDraft(updated);
        },
        summary() {
            const byPlatform = { tieba: 0, douyin: 0, xiaohongshu: 0 } satisfies Record<ExternalPlatform, number>;
            for (const draft of file.drafts) byPlatform[draft.platform]++;
            const lastAt = file.drafts.map(item => item.updatedAt).sort().at(-1);
            return {
                total: file.drafts.length,
                pending: file.drafts.filter(item => item.status === 'pending').length,
                approved: file.drafts.filter(item => item.status === 'approved').length,
                publishing: file.drafts.filter(item => item.status === 'publishing').length,
                failed: file.drafts.filter(item => item.status === 'failed').length,
                byPlatform,
                ...(lastAt ? { lastAt } : {}),
            };
        },
    };
}
