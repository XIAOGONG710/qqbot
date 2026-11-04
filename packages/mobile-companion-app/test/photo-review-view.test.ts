import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { PhotoReviewViewModel } from '../photo-review-view.js';

const now = Date.parse('2026-11-04T08:00:00.000Z');
const draft = {
    id: 'abcdef123456',
    kind: 'food',
    status: 'pending_review',
    caption: '刚做好的番茄鸡蛋面',
    createdAt: '2026-11-04T07:30:00.000Z',
    expiresAt: '2026-11-04T09:00:00.000Z',
    thumbnail: { mediaId: 'abcdef0123456789', mime: 'image/jpeg', bytes: 4096, width: 320, height: 240 },
};

test('PWA 照片审核模型不把内部编号、媒体引用或路径交给展示层', () => {
    const model = new PhotoReviewViewModel({ now: () => now });
    assert.deepEqual(model.beginRefresh('pending_review'), { status: 'pending_review', limit: 20 });
    model.replace({ items: [draft], total: 1 });
    const view = model.view();
    assert.equal(view.phase, 'ready');
    assert.equal(view.items[0]?.kindLabel, '吃饭记录');
    assert.equal(view.items[0]?.caption, draft.caption);
    assert.equal(JSON.stringify(view).includes(draft.id), false);
    assert.equal(JSON.stringify(view).includes(draft.thumbnail.mediaId), false);
    assert.deepEqual(model.thumbnailFor(view.items[0]!.key), draft.thumbnail);
    assert.throws(() => model.replace({ items: [{ ...draft, path: 'C:\\secret.jpg' }], total: 1 }), /不合法/);
});

test('PWA 通过和拒绝必须经过二次确认，审核结果不会产生发送动作', () => {
    const model = new PhotoReviewViewModel({ now: () => now });
    model.beginRefresh();
    model.replace({ items: [draft], total: 1 });
    const key = model.view().items[0]!.key;
    assert.throws(() => model.confirmDecision(), /先选择并确认/);
    model.requestDecision(key, 'approve');
    assert.match(model.view().confirmation!.message, /不会自动发送到 QQ/);
    assert.deepEqual(model.confirmDecision(), { draftId: draft.id, decision: 'approve', confirmation: 'confirmed' });
    model.applyDecision({ draftId: draft.id, status: 'approved', reviewedAt: '2026-11-04T08:01:00.000Z' });
    assert.equal(model.view().items[0]?.statusLabel, '已通过');
    assert.equal(model.view().items[0]?.canApprove, false);
    assert.equal(model.view().items[0]?.canReject, false);
    assert.equal(model.view().notice, '已通过；照片仍不会自动发送');
});

test('过期草稿显示中文状态、禁止通过但仍允许拒绝', () => {
    const model = new PhotoReviewViewModel({ now: () => now });
    model.beginRefresh();
    model.replace({ items: [{ ...draft, expiresAt: '2026-11-04T07:59:59.000Z' }], total: 1 });
    const item = model.view().items[0]!;
    assert.equal(item.statusLabel, '已过期');
    assert.equal(item.canApprove, false);
    assert.equal(item.canReject, true);
    assert.match(item.expiryLabel ?? '', /已于.*过期/);
    assert.throws(() => model.requestDecision(item.key, 'approve'), /已过期.*不能通过/);
    model.requestDecision(item.key, 'reject');
    assert.deepEqual(model.confirmDecision(), { draftId: draft.id, decision: 'reject', confirmation: 'confirmed' });
});

test('PWA 页面包含中文审核控件与受认证缩略图读取，并及时撤销 object URL', async () => {
    const root = resolve(import.meta.dirname, '..');
    const [html, app] = await Promise.all([
        readFile(resolve(root, 'index.html'), 'utf8'),
        readFile(resolve(root, 'app.js'), 'utf8'),
    ]);
    assert.match(html, /生活照审核/);
    assert.match(html, /审核不会自动发送到 QQ/);
    assert.match(html, /id="photoConfirm"/);
    assert.match(app, /photo\.review\.list/);
    assert.match(app, /photo\.review\.decide/);
    assert.match(app, /requestDecision\(key, decision\)/);
    assert.match(app, /'x-companion-session': session/);
    assert.match(app, /'x-companion-media-id': thumbnail\.mediaId/);
    assert.match(app, /URL\.createObjectURL\(blob\)/);
    assert.match(app, /URL\.revokeObjectURL\(url\)/);
    assert.doesNotMatch(app, /thumbnail\.mediaId.*(?:textContent|innerHTML)/);
});
