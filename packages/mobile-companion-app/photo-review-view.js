const DRAFT_ID = /^[a-f0-9]{12}$/;
const MEDIA_ID = /^[a-f0-9]{16,128}$/i;
const KINDS = Object.freeze({ cat: '猫咪日常', food: '吃饭记录', desk: '桌面随拍', view: '沿途风景' });
const STATUSES = Object.freeze({ pending_review: '待审核', approved: '已通过', rejected: '已拒绝' });
const SUMMARY_KEYS = new Set(['id', 'kind', 'status', 'caption', 'createdAt', 'expiresAt', 'reviewedAt', 'thumbnail']);
const THUMBNAIL_KEYS = new Set(['mediaId', 'mime', 'bytes', 'width', 'height']);

/** 零依赖 PWA 的安全展示模型；view() 永远不返回 draftId 或 mediaId。 */
export class PhotoReviewViewModel {
  constructor(options = {}) {
    this.timeZone = options.timeZone ?? 'Asia/Shanghai';
    this.now = options.now ?? Date.now;
    this.pageSize = Number.isInteger(options.pageSize) ? Math.max(1, Math.min(50, options.pageSize)) : 20;
    this.filter = 'pending_review';
    this.phase = 'idle';
    this.items = new Map();
    this.sequence = 0;
    this.pendingDecision = undefined;
    this.notice = undefined;
  }

  beginRefresh(filter = this.filter) {
    if (!['all', 'pending_review', 'approved', 'rejected'].includes(filter)) throw new Error('照片筛选条件不合法');
    if (this.phase === 'loading' || this.phase === 'submitting') throw new Error('上一项操作仍在处理中');
    this.filter = filter;
    this.phase = 'loading';
    this.notice = undefined;
    this.pendingDecision = undefined;
    return { ...(filter === 'all' ? {} : { status: filter }), limit: this.pageSize };
  }

  replace(result) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.items) || result.items.length > 50) return this.fail();
    if (!Number.isInteger(result.total) || result.total < result.items.length || result.total > 100_000) return this.fail();
    const drafts = result.items.map(validateSummary);
    this.items.clear();
    for (const draft of drafts) {
      const key = `photo-${++this.sequence}`;
      this.items.set(key, { key, draft });
    }
    this.phase = 'ready';
    this.pendingDecision = undefined;
    this.notice = drafts.length ? undefined : '没有符合当前筛选条件的草稿';
  }

  requestDecision(key, decision) {
    if (this.phase === 'loading' || this.phase === 'submitting') throw new Error('上一项操作仍在处理中');
    const item = this.items.get(key);
    if (!item || item.draft.status !== 'pending_review') throw new Error('这张照片当前不能审核');
    if (!['approve', 'reject'].includes(decision)) throw new Error('审核操作不合法');
    if (decision === 'approve' && this.isExpired(item.draft)) throw new Error('这张照片已过期，不能通过');
    this.pendingDecision = { key, decision };
    this.notice = undefined;
    this.phase = 'confirming';
  }

  cancelDecision() {
    if (this.phase !== 'confirming') return;
    this.pendingDecision = undefined;
    this.phase = 'ready';
  }

  confirmDecision() {
    if (this.phase !== 'confirming' || !this.pendingDecision) throw new Error('请先选择并确认审核操作');
    const item = this.items.get(this.pendingDecision.key);
    if (!item || item.draft.status !== 'pending_review') throw new Error('这张照片当前不能审核');
    if (this.pendingDecision.decision === 'approve' && this.isExpired(item.draft)) throw new Error('这张照片已过期，不能通过');
    this.phase = 'submitting';
    return { draftId: item.draft.id, decision: this.pendingDecision.decision, confirmation: 'confirmed' };
  }

  applyDecision(result) {
    if (!result || typeof result !== 'object' || !DRAFT_ID.test(String(result.draftId)) || !['approved', 'rejected'].includes(result.status) || !validDate(result.reviewedAt)) return this.fail();
    const item = [...this.items.values()].find(candidate => candidate.draft.id === result.draftId);
    if (!item) return this.fail();
    item.draft = { ...item.draft, status: result.status, reviewedAt: result.reviewedAt };
    this.phase = 'ready';
    this.pendingDecision = undefined;
    this.notice = result.status === 'approved' ? '已通过；照片仍不会自动发送' : '已拒绝这张草稿';
  }

  fail() {
    this.phase = 'error';
    this.pendingDecision = undefined;
    this.notice = '审核数据无法读取，请重新配对或稍后重试';
  }

  reset() {
    this.items.clear();
    this.phase = 'idle';
    this.pendingDecision = undefined;
    this.notice = undefined;
  }

  thumbnailFor(key) {
    const thumbnail = this.items.get(key)?.draft.thumbnail;
    return thumbnail ? { ...thumbnail } : undefined;
  }

  view() {
    return {
      phase: this.phase,
      filter: this.filter,
      busy: this.phase === 'loading' || this.phase === 'submitting',
      notice: this.notice,
      emptyText: this.phase === 'loading' ? '正在读取草稿…' : '这里暂时没有照片草稿',
      confirmation: this.pendingDecision ? confirmationFor(this.pendingDecision.decision) : undefined,
      items: [...this.items.values()].map(({ key, draft }) => {
        const expired = this.isExpired(draft);
        return {
          key,
          kindLabel: KINDS[draft.kind],
          statusLabel: expired && draft.status === 'pending_review' ? '已过期' : STATUSES[draft.status],
          caption: draft.caption,
          timeLabel: formatTime(draft.createdAt, this.timeZone),
          expiryLabel: draft.expiresAt ? `${expired ? '已于' : '有效至'} ${formatTime(draft.expiresAt, this.timeZone)}${expired ? ' 过期' : ''}` : undefined,
          hasThumbnail: Boolean(draft.thumbnail),
          canApprove: draft.status === 'pending_review' && !expired,
          canReject: draft.status === 'pending_review',
        };
      }),
    };
  }

  isExpired(draft) { return draft.expiresAt !== undefined && Date.parse(draft.expiresAt) <= this.now(); }
}

function validateSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !SUMMARY_KEYS.has(key))) throw new Error('照片摘要不合法');
  if (!DRAFT_ID.test(String(value.id)) || !Object.hasOwn(KINDS, value.kind) || !Object.hasOwn(STATUSES, value.status)) throw new Error('照片摘要不合法');
  if (typeof value.caption !== 'string' || !value.caption.trim() || [...value.caption].length > 200 || /[\u0000-\u001f\u007f]/.test(value.caption)) throw new Error('照片摘要不合法');
  if (!validDate(value.createdAt) || (value.expiresAt !== undefined && !validDate(value.expiresAt)) || (value.reviewedAt !== undefined && !validDate(value.reviewedAt))) throw new Error('照片摘要不合法');
  const thumbnail = value.thumbnail === undefined ? undefined : validateThumbnail(value.thumbnail);
  return { id: value.id, kind: value.kind, status: value.status, caption: value.caption, createdAt: value.createdAt, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), ...(value.reviewedAt ? { reviewedAt: value.reviewedAt } : {}), ...(thumbnail ? { thumbnail } : {}) };
}

function validateThumbnail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !THUMBNAIL_KEYS.has(key))) throw new Error('照片缩略图不合法');
  if (!MEDIA_ID.test(String(value.mediaId)) || !['image/jpeg', 'image/png', 'image/webp'].includes(value.mime) || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > 1024 * 1024) throw new Error('照片缩略图不合法');
  for (const key of ['width', 'height']) if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 4096)) throw new Error('照片缩略图不合法');
  return { mediaId: value.mediaId, mime: value.mime, bytes: value.bytes, ...(value.width ? { width: value.width } : {}), ...(value.height ? { height: value.height } : {}) };
}

function confirmationFor(decision) {
  return decision === 'approve'
    ? { title: '确认通过这张照片？', message: '通过只会把草稿标记为已审核，不会自动发送到 QQ。', confirmLabel: '确认通过', tone: 'positive' }
    : { title: '确认拒绝这张照片？', message: '拒绝后这张草稿将不再进入待审核列表。', confirmLabel: '确认拒绝', tone: 'danger' };
}

function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
