import type { CompanionEnvelope } from './protocol.ts';
import { CompanionClient } from './client.ts';
import {
    validatePhotoReviewDecisionResult,
    validatePhotoReviewListResult,
    type PhotoDraftReviewStatus,
    type PhotoDraftSummary,
    type PhotoDraftThumbnail,
    type PhotoReviewDecisionRequest,
    type PhotoReviewListRequest,
} from './photo-review.ts';

export type PhotoReviewUiPhase = 'idle' | 'loading' | 'ready' | 'confirming' | 'submitting' | 'error';
export type PhotoReviewUiFilter = PhotoDraftReviewStatus | 'all';

export interface PhotoReviewUiItem {
    /** 仅供列表选中使用，不应作为文案展示。 */
    key: string;
    kindLabel: string;
    statusLabel: string;
    caption: string;
    createdLabel: string;
    reviewedLabel?: string;
    expiryLabel?: string;
    hasThumbnail: boolean;
    canApprove: boolean;
    canReject: boolean;
}

export interface PhotoReviewUiConfirmation {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: 'positive' | 'danger';
}

export interface PhotoReviewUiView {
    title: string;
    subtitle: string;
    phase: PhotoReviewUiPhase;
    busy: boolean;
    filter: PhotoReviewUiFilter;
    refreshLabel: string;
    emptyText: string;
    items: PhotoReviewUiItem[];
    confirmation?: PhotoReviewUiConfirmation;
    notice?: string;
}

export interface PhotoReviewUiOptions {
    now?: () => number;
    timeZone?: string;
    pageSize?: number;
}

interface InternalItem {
    key: string;
    draft: PhotoDraftSummary;
}

interface PendingDecision {
    key: string;
    decision: PhotoReviewDecisionRequest['decision'];
}

const KIND_LABELS: Record<PhotoDraftSummary['kind'], string> = {
    cat: '猫咪日常',
    food: '吃饭记录',
    desk: '桌面随拍',
    view: '沿途风景',
};

const STATUS_LABELS: Record<PhotoDraftReviewStatus, string> = {
    pending_review: '待审核',
    approved: '已通过',
    rejected: '已拒绝',
};

/**
 * Android / Flutter / PWA 都可直接消费的中文审核页面状态机。
 *
 * 对外 view 不包含草稿 id、mediaId、路径、提示词或模型名。缩略图引用只能通过
 * thumbnailFor() 按当前页面的内部 key 单独取得，避免界面误把技术标识渲染成文字。
 */
export class PhotoReviewUiController {
    private readonly client: CompanionClient;
    private readonly now: () => number;
    private readonly timeZone: string;
    private readonly pageSize: number;
    private readonly itemByKey = new Map<string, InternalItem>();
    private phase: PhotoReviewUiPhase = 'idle';
    private filter: PhotoReviewUiFilter = 'pending_review';
    private notice: string | undefined;
    private pendingDecision: PendingDecision | undefined;
    private activeRequestId: string | undefined;
    private keySequence = 0;

    constructor(client: CompanionClient, options: PhotoReviewUiOptions = {}) {
        this.client = client;
        this.now = options.now ?? Date.now;
        this.timeZone = options.timeZone ?? 'Asia/Shanghai';
        this.pageSize = clampPageSize(options.pageSize ?? 20);
    }

    view(): PhotoReviewUiView {
        const items = [...this.itemByKey.values()].map(item => this.toUiItem(item));
        return {
            title: '生活照审核',
            subtitle: '通过或拒绝草稿；审核不会自动发送到 QQ',
            phase: this.phase,
            busy: this.phase === 'loading' || this.phase === 'submitting',
            filter: this.filter,
            refreshLabel: this.phase === 'loading' ? '正在刷新…' : '刷新',
            emptyText: this.phase === 'loading' ? '正在读取草稿…' : '这里暂时没有照片草稿',
            items,
            confirmation: this.pendingDecision ? confirmationFor(this.pendingDecision.decision) : undefined,
            notice: this.notice,
        };
    }

    refresh(filter: PhotoReviewUiFilter = this.filter): CompanionEnvelope<PhotoReviewListRequest> {
        this.assertNotBusy();
        this.filter = filter;
        this.notice = undefined;
        this.pendingDecision = undefined;
        const request = this.client.listPhotoDrafts({
            ...(filter === 'all' ? {} : { status: filter }),
            limit: this.pageSize,
        });
        this.activeRequestId = request.requestId;
        this.phase = 'loading';
        return request;
    }

    requestDecision(key: string, decision: PhotoReviewDecisionRequest['decision']): void {
        this.assertNotBusy();
        const item = this.itemByKey.get(key);
        if (!item || item.draft.status !== 'pending_review') throw new Error('这张照片当前不能审核');
        if (decision !== 'approve' && decision !== 'reject') throw new Error('审核操作不合法');
        if (decision === 'approve' && this.isExpired(item.draft)) throw new Error('这张照片已过期，不能通过');
        this.pendingDecision = { key, decision };
        this.notice = undefined;
        this.phase = 'confirming';
    }

    cancelDecision(): void {
        if (this.phase !== 'confirming') return;
        this.pendingDecision = undefined;
        this.phase = 'ready';
    }

    confirmDecision(): CompanionEnvelope<PhotoReviewDecisionRequest> {
        if (this.phase !== 'confirming' || !this.pendingDecision) throw new Error('请先选择并确认审核操作');
        const item = this.itemByKey.get(this.pendingDecision.key);
        if (!item || item.draft.status !== 'pending_review') throw new Error('这张照片当前不能审核');
        if (this.pendingDecision.decision === 'approve' && this.isExpired(item.draft)) throw new Error('这张照片已过期，不能通过');
        const request = this.client.decidePhotoDraft({
            draftId: item.draft.id,
            decision: this.pendingDecision.decision,
            confirmation: 'confirmed',
        });
        this.activeRequestId = request.requestId;
        this.phase = 'submitting';
        this.notice = undefined;
        return request;
    }

    /**
     * 处理 CompanionClient 收到的审核响应。错误只显示固定中文提示，不把服务端异常、
     * 路径或内部编号带进页面。
     */
    accept(value: unknown): void {
        try {
            const envelope = this.client.accept(value);
            const requestId = responseRequestId(envelope.requestId);
            if (!this.activeRequestId || requestId !== this.activeRequestId) throw new Error('审核响应与当前页面请求不匹配');
            this.activeRequestId = undefined;

            if (envelope.kind === 'error') {
                this.pendingDecision = undefined;
                this.phase = 'error';
                this.notice = '操作未完成，请稍后重试';
                return;
            }
            if (envelope.kind === 'photo.review.list.result') {
                const result = validatePhotoReviewListResult(envelope.body);
                this.replaceItems(result.items);
                this.pendingDecision = undefined;
                this.phase = 'ready';
                this.notice = result.items.length ? undefined : '没有符合当前筛选条件的草稿';
                return;
            }
            if (envelope.kind === 'photo.review.decision') {
                const result = validatePhotoReviewDecisionResult(envelope.body);
                const item = [...this.itemByKey.values()].find(candidate => candidate.draft.id === result.draftId);
                if (!item) throw new Error('审核结果对应的草稿不在当前页面');
                item.draft = { ...item.draft, status: result.status, reviewedAt: result.reviewedAt };
                this.pendingDecision = undefined;
                this.phase = 'ready';
                this.notice = result.status === 'approved' ? '已通过；照片仍不会自动发送' : '已拒绝这张草稿';
                return;
            }
            throw new Error('不是照片审核响应');
        } catch {
            this.activeRequestId = undefined;
            this.pendingDecision = undefined;
            this.phase = 'error';
            this.notice = '审核数据无法读取，请重新配对或稍后重试';
        }
    }

    /** 传输层用 mediaId 读取短期缩略图；返回值不应直接渲染为文字。 */
    thumbnailFor(key: string): PhotoDraftThumbnail | undefined {
        const thumbnail = this.itemByKey.get(key)?.draft.thumbnail;
        return thumbnail ? { ...thumbnail } : undefined;
    }

    dismissNotice(): void {
        this.notice = undefined;
        if (this.phase === 'error') this.phase = this.itemByKey.size ? 'ready' : 'idle';
    }

    private replaceItems(drafts: PhotoDraftSummary[]): void {
        this.itemByKey.clear();
        for (const draft of drafts) {
            this.keySequence += 1;
            const key = `item-${this.keySequence}`;
            this.itemByKey.set(key, { key, draft: { ...draft, thumbnail: draft.thumbnail ? { ...draft.thumbnail } : undefined } });
        }
    }

    private toUiItem(item: InternalItem): PhotoReviewUiItem {
        const expired = this.isExpired(item.draft);
        return {
            key: item.key,
            kindLabel: KIND_LABELS[item.draft.kind],
            statusLabel: expired && item.draft.status === 'pending_review' ? '已过期' : STATUS_LABELS[item.draft.status],
            caption: item.draft.caption,
            createdLabel: `创建于 ${formatTime(item.draft.createdAt, this.timeZone, this.now())}`,
            reviewedLabel: item.draft.reviewedAt ? `审核于 ${formatTime(item.draft.reviewedAt, this.timeZone, this.now())}` : undefined,
            expiryLabel: item.draft.expiresAt ? `${expired ? '已于' : '有效至'} ${formatTime(item.draft.expiresAt, this.timeZone, this.now())}${expired ? ' 过期' : ''}` : undefined,
            hasThumbnail: Boolean(item.draft.thumbnail),
            canApprove: item.draft.status === 'pending_review' && !expired,
            canReject: item.draft.status === 'pending_review',
        };
    }

    private isExpired(draft: PhotoDraftSummary): boolean {
        return draft.expiresAt !== undefined && Date.parse(draft.expiresAt) <= this.now();
    }

    private assertNotBusy(): void {
        if (this.phase === 'loading' || this.phase === 'submitting') throw new Error('正在处理上一项操作，请稍候');
    }
}

function confirmationFor(decision: PhotoReviewDecisionRequest['decision']): PhotoReviewUiConfirmation {
    if (decision === 'approve') {
        return {
            title: '确认通过这张照片？',
            message: '通过只会把草稿标记为已审核，不会自动发送到 QQ。',
            confirmLabel: '确认通过',
            cancelLabel: '再看看',
            tone: 'positive',
        };
    }
    return {
        title: '确认拒绝这张照片？',
        message: '拒绝后这张草稿将不再进入待审核列表。',
        confirmLabel: '确认拒绝',
        cancelLabel: '取消',
        tone: 'danger',
    };
}

function formatTime(iso: string, timeZone: string, now: number): string {
    const created = Date.parse(iso);
    const sameYear = new Date(created).toLocaleDateString('en-CA', { timeZone, year: 'numeric' }).slice(0, 4)
        === new Date(now).toLocaleDateString('en-CA', { timeZone, year: 'numeric' }).slice(0, 4);
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        ...(sameYear ? {} : { year: 'numeric' }),
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(created));
}

function responseRequestId(requestId: string): string {
    return requestId.startsWith('resp-') ? requestId.slice(5) : requestId;
}

function clampPageSize(value: number): number {
    if (!Number.isInteger(value)) throw new Error('照片审核每页数量不合法');
    return Math.max(1, Math.min(50, value));
}
