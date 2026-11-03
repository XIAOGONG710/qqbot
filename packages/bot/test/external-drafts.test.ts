import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { createExternalDraftStore } from '../src/social/external-drafts.ts';

const roots: string[] = [];
const originalRename = fileOps.renameSync;
afterEach(() => {
    fileOps.renameSync = originalRename;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('外部平台草稿队列（ADR 0224）', () => {
    test('状态推进写盘成功后才替换内存', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        const draft = store.create({ platform: 'tieba', title: '标题', body: '正文' });
        fileOps.renameSync = (() => { throw new Error('disk full'); }) as typeof fileOps.renameSync;
        try {
            assert.throws(() => store.updateStatus(draft.id, 'approved'), /disk full/);
            assert.equal(store.list({ status: 'pending' }).length, 1);
            assert.equal(store.list({ status: 'approved' }).length, 0);
        } finally { fileOps.renameSync = originalRename; }
    });

    test('创建草稿写盘失败时不留内存孤儿', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        fileOps.renameSync = (() => { throw new Error('disk full'); }) as typeof fileOps.renameSync;
        try {
            assert.throws(() => store.create({ platform: 'douyin', title: '标题', body: '正文' }), /disk full/);
            assert.deepEqual(store.list(), []);
        } finally { fileOps.renameSync = originalRename; }
    });

    test('列表分页遇到无效数字时回退到默认页大小', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        store.create({ platform: 'tieba', title: '标题一', body: '正文一' });
        store.create({ platform: 'tieba', title: '标题二', body: '正文二' });
        assert.equal(store.list({ limit: Number.NaN }).length, 2);
        assert.equal(store.list({ limit: Number.POSITIVE_INFINITY }).length, 2);
    });

    test('适配器重复回写同一状态时保持幂等，不改时间也不追加审计', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        const draft = store.create({ platform: 'xiaohongshu', title: '标题', body: '正文', at: new Date('2026-11-03T00:00:00.000Z') });
        const approved = store.updateStatus(draft.id, 'approved', '人工确认', new Date('2026-11-03T00:01:00.000Z'))!;
        const repeated = store.updateStatus(draft.id, 'approved', '适配器重试', new Date('2026-11-03T00:02:00.000Z'))!;
        assert.deepEqual(repeated, approved);
        assert.equal(repeated.audit.length, 2);
        assert.equal(repeated.updatedAt, '2026-11-03T00:01:00.000Z');
        assert.deepEqual(createExternalDraftStore({ dir: root }).list()[0], approved);
    });

    test('本地素材只接受逻辑 media ID，拒绝绝对路径和路径穿越', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        assert.doesNotThrow(() => store.create({
            platform: 'douyin', title: '标题', body: '正文', media: ['media:photos/cat-01.jpg', 'media:upload_2026'],
        }));
        for (const media of ['media:../../secret', 'media:/absolute/path', 'media:photos/../secret', 'media:.hidden/file']) {
            assert.throws(() => store.create({ platform: 'douyin', title: '标题', body: '正文', media: [media] }), /素材只允许/);
        }
    });
});
