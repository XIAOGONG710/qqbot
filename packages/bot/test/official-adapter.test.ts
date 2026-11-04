import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExternalDraftStore } from '../src/social/external-drafts.ts';
import { publishExternalDraft } from '../src/social/official-adapter.ts';

const dirs: string[] = [];
after(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })));
const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'official-adapter-')); dirs.push(dir);
    return createExternalDraftStore({ dir, canDraft: () => true, canPublish: () => true });
};

test('官方适配器要求双重确认并复用稳定幂等键', async () => {
    const drafts = store();
    const draft = drafts.create({ platform: 'douyin', title: '标题', body: '正文' });
    drafts.updateStatus(draft.id, 'approved');
    let key = '';
    await assert.rejects(() => publishExternalDraft({ store: drafts, adapter: { platform: 'douyin', authorized: async () => true, publish: async () => ({ outcome: 'accepted' }) }, draftId: draft.id, confirmation: 'no' }), /确认/);
    const result = await publishExternalDraft({
        store: drafts,
        adapter: { platform: 'douyin', authorized: async () => true, publish: async (_item, idempotencyKey) => { key = idempotencyKey; return { outcome: 'accepted', receipt: 'remote-42' }; } },
        draftId: draft.id, confirmation: 'confirmed',
    });
    assert.deepEqual(result, { status: 'published', receipt: 'remote-42' });
    assert.match(key, /^publish-douyin-/);
});

test('结果不确定时保持 publishing 并阻止自动重发', async () => {
    const drafts = store();
    const draft = drafts.create({ platform: 'tieba', title: '标题', body: '正文' });
    drafts.updateStatus(draft.id, 'approved');
    const adapter = { platform: 'tieba' as const, authorized: async () => true, publish: async () => { throw new Error('timeout'); } };
    assert.equal((await publishExternalDraft({ store: drafts, adapter, draftId: draft.id, confirmation: 'confirmed' })).status, 'reconcile');
    assert.equal(drafts.list({ status: 'publishing' })[0]?.id, draft.id);
    assert.equal((await publishExternalDraft({ store: drafts, adapter, draftId: draft.id, confirmation: 'confirmed' })).status, 'reconcile');
});
