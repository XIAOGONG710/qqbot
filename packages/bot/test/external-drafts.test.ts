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
});
