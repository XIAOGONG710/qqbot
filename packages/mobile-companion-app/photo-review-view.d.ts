export type PhotoReviewFilter = 'all' | 'pending_review' | 'approved' | 'rejected';
export type PhotoReviewDecision = 'approve' | 'reject';

export interface PhotoReviewDisplayItem {
    key: string;
    kindLabel: string;
    statusLabel: string;
    caption: string;
    timeLabel: string;
    expiryLabel?: string;
    hasThumbnail: boolean;
    canApprove: boolean;
    canReject: boolean;
}

export class PhotoReviewViewModel {
    constructor(options?: { timeZone?: string; pageSize?: number; now?: () => number });
    beginRefresh(filter?: PhotoReviewFilter): { status?: Exclude<PhotoReviewFilter, 'all'>; limit: number };
    replace(result: unknown): void;
    requestDecision(key: string, decision: PhotoReviewDecision): void;
    cancelDecision(): void;
    confirmDecision(): { draftId: string; decision: PhotoReviewDecision; confirmation: 'confirmed' };
    applyDecision(result: unknown): void;
    fail(): void;
    reset(): void;
    thumbnailFor(key: string): { mediaId: string; mime: string; bytes: number; width?: number; height?: number } | undefined;
    view(): {
        phase: 'idle' | 'loading' | 'ready' | 'confirming' | 'submitting' | 'error';
        filter: PhotoReviewFilter;
        busy: boolean;
        notice?: string;
        emptyText: string;
        confirmation?: { title: string; message: string; confirmLabel: string; tone: 'positive' | 'danger' };
        items: PhotoReviewDisplayItem[];
    };
}
