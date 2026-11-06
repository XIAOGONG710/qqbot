import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CompanionClient } from '../src/client.ts';
import { PhotoReviewUiController } from '../src/photo-review-ui.ts';

const now = Date.parse('2026-11-04T08:00:00.000Z');
const draft = {
    id: 'abcdef123456',
    kind: 'cat' as const,
    status: 'pending_review' as const,
    caption: '团子饼趴在窗边晒太阳',
    createdAt: '2026-11-04T07:30:00.000Z',
    expiresAt: '2026-11-04T09:00:00.000Z',
    thumbnail: {
        mediaId: 'abcdef0123456789',
        mime: 'image/jpeg' as const,
        bytes: 4096,
        width: 320,
        height: 320,
    },
};

function setup(): { client: CompanionClient; ui: PhotoReviewUiController } {
    let nonce = 0;
    const client = new CompanionClient({
        clientId: 'android-photo-ui',
        pairingCode: 'ABCD-1234',
        capabilities: ['text'],
        now: () => now,
        nonce: () => `photo-ui-nonce-${++nonce}`,
    });
    return { client, ui: new PhotoReviewUiController(client, { now: () => now }) };
}

function response(requestId: string, kind: 'photo.review.list.result' | 'photo.review.decision' | 'error', body: unknown, nonce: string) {
    return { v: 1 as const, requestId: `resp-${requestId}`, kind, sentAt: new Date(now).toISOString(), nonce, body };
}

describe('手机伴侣照片审核中文 UI 层', () => {
    test('页面模型只给中文展示字段，不暴露草稿编号或 mediaId', () => {
        const { ui } = setup();
        const request = ui.refresh();
        assert.equal(ui.view().phase, 'loading');
        assert.deepEqual(request.body, { status: 'pending_review', limit: 20 });

        ui.accept(response(request.requestId, 'photo.review.list.result', { items: [draft], total: 1 }, 'server-photo-ui-01'));
        const view = ui.view();
        assert.equal(view.phase, 'ready');
        assert.equal(view.title, '生活照审核');
        assert.equal(view.items[0]?.kindLabel, '猫咪日常');
        assert.equal(view.items[0]?.statusLabel, '待审核');
        assert.equal(view.items[0]?.caption, draft.caption);
        assert.equal(view.items[0]?.hasThumbnail, true);
        assert.equal(JSON.stringify(view).includes(draft.id), false);
        assert.equal(JSON.stringify(view).includes(draft.thumbnail.mediaId), false);
        assert.deepEqual(ui.thumbnailFor(view.items[0]!.key), draft.thumbnail);
    });

    test('通过与拒绝必须先展示确认，确认后才生成 confirmed 请求', () => {
        const { ui } = setup();
        const list = ui.refresh();
        ui.accept(response(list.requestId, 'photo.review.list.result', { items: [draft], total: 1 }, 'server-photo-ui-02'));
        const key = ui.view().items[0]!.key;

        ui.requestDecision(key, 'approve');
        assert.equal(ui.view().phase, 'confirming');
        assert.match(ui.view().confirmation!.message, /不会自动发送到 QQ/);
        ui.cancelDecision();
        assert.equal(ui.view().phase, 'ready');

        ui.requestDecision(key, 'approve');
        const decision = ui.confirmDecision();
        assert.equal(ui.view().phase, 'submitting');
        assert.deepEqual(decision.body, { draftId: draft.id, decision: 'approve', confirmation: 'confirmed' });
        ui.accept(response(decision.requestId, 'photo.review.decision', {
            draftId: draft.id,
            status: 'approved',
            reviewedAt: new Date(now).toISOString(),
        }, 'server-photo-ui-03'));
        const view = ui.view();
        assert.equal(view.items[0]?.statusLabel, '已通过');
        assert.equal(view.items[0]?.canApprove, false);
        assert.equal(view.items[0]?.canReject, false);
        assert.equal(view.notice, '已通过；照片仍不会自动发送');
        assert.throws(() => ui.requestDecision(key, 'reject'), /不能审核/);
    });

    test('服务端错误和恶意内部路径不会进入页面文案', () => {
        const { ui } = setup();
        const list = ui.refresh('all');
        ui.accept(response(list.requestId, 'error', {
            code: 'runtime_error',
            message: 'backend failed at C:\\Users\\secret\\draft.json',
        }, 'server-photo-ui-04'));
        const view = ui.view();
        assert.equal(view.phase, 'error');
        assert.equal(view.notice, '操作未完成，请稍后重试');
        assert.equal(JSON.stringify(view).includes('secret'), false);
        assert.equal(JSON.stringify(view).includes('runtime_error'), false);
    });

    test('过期草稿禁止通过但仍允许明确拒绝', () => {
        const { ui } = setup();
        const list = ui.refresh();
        ui.accept(response(list.requestId, 'photo.review.list.result', { items: [{ ...draft, expiresAt: '2026-11-04T07:59:59.000Z' }], total: 1 }, 'server-photo-ui-expired'));
        const item = ui.view().items[0]!;
        assert.equal(item.statusLabel, '已过期');
        assert.equal(item.canApprove, false);
        assert.equal(item.canReject, true);
        assert.match(item.expiryLabel ?? '', /已于.*过期/);
        assert.throws(() => ui.requestDecision(item.key, 'approve'), /已过期.*不能通过/);
        ui.requestDecision(item.key, 'reject');
        assert.deepEqual(ui.confirmDecision().body, { draftId: draft.id, decision: 'reject', confirmation: 'confirmed' });
    });

    test('响应不匹配时失败关闭并提供中文恢复提示', () => {
        const { ui } = setup();
        const list = ui.refresh();
        ui.accept(response(`${list.requestId}-wrong`, 'photo.review.list.result', { items: [draft], total: 1 }, 'server-photo-ui-05'));
        assert.equal(ui.view().phase, 'error');
        assert.equal(ui.view().notice, '审核数据无法读取，请重新配对或稍后重试');
    });
});
