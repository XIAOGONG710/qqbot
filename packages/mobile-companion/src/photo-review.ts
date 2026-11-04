/**
 * 手机伴侣的 AI 生活照审核契约（ADR 0245）。
 *
 * 这里只传草稿编号、中文说明和短期缩略图 mediaId；绝不传原图路径、提示词、
 * eventKey、模型名或密钥。通过/拒绝必须由已配对设备显式确认，真正的状态修改和
 * 审计仍由宿主回调完成。
 */

export const PHOTO_REVIEW_MAX_ITEMS = 50;
export const PHOTO_REVIEW_MAX_THUMBNAIL_BYTES = 1024 * 1024;

export type PhotoDraftKind = 'cat' | 'food' | 'desk' | 'view';
export type PhotoDraftReviewStatus = 'pending_review' | 'approved' | 'rejected';

export interface PhotoDraftThumbnail {
    /** 必须是媒体仓库签发的短期 id；不允许 URL 或文件路径。 */
    mediaId: string;
    mime: 'image/jpeg' | 'image/png' | 'image/webp';
    bytes: number;
    width?: number;
    height?: number;
}

export interface PhotoDraftSummary {
    id: string;
    kind: PhotoDraftKind;
    status: PhotoDraftReviewStatus;
    caption: string;
    createdAt: string;
    reviewedAt?: string;
    thumbnail?: PhotoDraftThumbnail;
}

export interface PhotoReviewListRequest {
    status?: PhotoDraftReviewStatus;
    limit?: number;
}

export interface PhotoReviewListResult {
    items: PhotoDraftSummary[];
    total: number;
}

export interface PhotoReviewDecisionRequest {
    draftId: string;
    decision: 'approve' | 'reject';
    /** 客户端必须先展示确认界面；没有这个字面量，服务端失败关闭。 */
    confirmation: 'confirmed';
}

export interface PhotoReviewDecisionResult {
    draftId: string;
    status: 'approved' | 'rejected';
    reviewedAt: string;
}

const DRAFT_ID = /^[a-f0-9]{12}$/;
const MEDIA_ID = /^[a-f0-9]{16,128}$/i;
const KINDS = new Set<PhotoDraftKind>(['cat', 'food', 'desk', 'view']);
const STATUSES = new Set<PhotoDraftReviewStatus>(['pending_review', 'approved', 'rejected']);

const date = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label}不合法`);
    return value;
};

const exactKeys = (input: Record<string, unknown>, allowed: readonly string[], label: string): void => {
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(`${label}含有不允许的字段`);
};

export function validatePhotoDraftThumbnail(value: unknown): PhotoDraftThumbnail {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缩略图信息不合法');
    const input = value as Record<string, unknown>;
    exactKeys(input, ['mediaId', 'mime', 'bytes', 'width', 'height'], '缩略图信息');
    if (typeof input.mediaId !== 'string' || !MEDIA_ID.test(input.mediaId)) throw new Error('缩略图 mediaId 不合法');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(input.mime))) throw new Error('缩略图格式不支持');
    if (!Number.isInteger(input.bytes) || Number(input.bytes) < 1 || Number(input.bytes) > PHOTO_REVIEW_MAX_THUMBNAIL_BYTES) throw new Error('缩略图大小不合法');
    for (const key of ['width', 'height'] as const) {
        if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) < 1 || Number(input[key]) > 4096)) throw new Error(`缩略图${key === 'width' ? '宽度' : '高度'}不合法`);
    }
    return input as unknown as PhotoDraftThumbnail;
}

export function validatePhotoDraftSummary(value: unknown): PhotoDraftSummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片草稿摘要不合法');
    const input = value as Record<string, unknown>;
    // 严格拒绝 path / prompt / eventKey 等多余字段，避免宿主误把完整索引直接回传手机。
    exactKeys(input, ['id', 'kind', 'status', 'caption', 'createdAt', 'reviewedAt', 'thumbnail'], '照片草稿摘要');
    if (typeof input.id !== 'string' || !DRAFT_ID.test(input.id)) throw new Error('照片草稿编号不合法');
    if (!KINDS.has(input.kind as PhotoDraftKind)) throw new Error('照片草稿类型不合法');
    if (!STATUSES.has(input.status as PhotoDraftReviewStatus)) throw new Error('照片草稿状态不合法');
    if (typeof input.caption !== 'string' || !input.caption.trim() || [...input.caption].length > 200 || /[\u0000-\u001f\u007f]/.test(input.caption)) throw new Error('照片草稿说明不合法');
    date(input.createdAt, '照片草稿创建时间');
    if (input.reviewedAt !== undefined) date(input.reviewedAt, '照片草稿审核时间');
    if (input.thumbnail !== undefined) validatePhotoDraftThumbnail(input.thumbnail);
    return input as unknown as PhotoDraftSummary;
}

export function validatePhotoReviewListRequest(value: unknown): PhotoReviewListRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片审核列表请求不合法');
    const input = value as Record<string, unknown>;
    exactKeys(input, ['status', 'limit'], '照片审核列表请求');
    if (input.status !== undefined && !STATUSES.has(input.status as PhotoDraftReviewStatus)) throw new Error('照片审核状态筛选不合法');
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > PHOTO_REVIEW_MAX_ITEMS)) throw new Error('照片审核列表数量不合法');
    return input as PhotoReviewListRequest;
}

export function validatePhotoReviewListResult(value: unknown): PhotoReviewListResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片审核列表结果不合法');
    const input = value as Record<string, unknown>;
    exactKeys(input, ['items', 'total'], '照片审核列表结果');
    if (!Array.isArray(input.items) || input.items.length > PHOTO_REVIEW_MAX_ITEMS) throw new Error('照片审核列表过长');
    const items = input.items.map(validatePhotoDraftSummary);
    if (!Number.isInteger(input.total) || Number(input.total) < items.length || Number(input.total) > 100_000) throw new Error('照片审核总数不合法');
    return { items, total: Number(input.total) };
}

export function validatePhotoReviewDecisionRequest(value: unknown): PhotoReviewDecisionRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片审核决定不合法');
    const input = value as Record<string, unknown>;
    exactKeys(input, ['draftId', 'decision', 'confirmation'], '照片审核决定');
    if (typeof input.draftId !== 'string' || !DRAFT_ID.test(input.draftId)) throw new Error('照片草稿编号不合法');
    if (!['approve', 'reject'].includes(String(input.decision))) throw new Error('照片审核决定不合法');
    if (input.confirmation !== 'confirmed') throw new Error('照片审核需要明确确认');
    return input as unknown as PhotoReviewDecisionRequest;
}

export function validatePhotoReviewDecisionResult(value: unknown): PhotoReviewDecisionResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('照片审核结果不合法');
    const input = value as Record<string, unknown>;
    exactKeys(input, ['draftId', 'status', 'reviewedAt'], '照片审核结果');
    if (typeof input.draftId !== 'string' || !DRAFT_ID.test(input.draftId)) throw new Error('照片草稿编号不合法');
    if (!['approved', 'rejected'].includes(String(input.status))) throw new Error('照片审核结果状态不合法');
    date(input.reviewedAt, '照片草稿审核时间');
    return input as unknown as PhotoReviewDecisionResult;
}

