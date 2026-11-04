import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileOps } from '../src/memory/json-file.ts';
import { createExternalDraftStore, MAX_EXTERNAL_DRAFTS, type ExternalDraft, type ExternalDraftStatus } from '../src/social/external-drafts.ts';

const roots: string[] = [];
const originalRename = fileOps.renameSync;
const seeded = (index: number, status: ExternalDraftStatus): ExternalDraft => {
    const at = new Date(Date.parse('2026-11-01T00:00:00.000Z') + index * 1000).toISOString();
    const audit = status === 'pending' ? [{ at, status }]
        : status === 'rejected' ? [{ at, status: 'pending' as const }, { at, status }]
            : [{ at, status: 'pending' as const }, { at, status: 'approved' as const }, ...(status === 'approved' ? [] : [{ at, status }])];
    return {
        id: `seed-${String(index).padStart(4, '0')}`, platform: 'tieba', title: `标题${index}`, body: `正文${index}`,
        media: [], createdAt: at, updatedAt: at, status, source: 'manual', audit,
    };
};
const seedStore = (root: string, statuses: ExternalDraftStatus[]) => {
    writeFileSync(join(root, 'drafts.json'), JSON.stringify({ version: 1, drafts: statuses.map((status, index) => seeded(index, status)) }));
    return createExternalDraftStore({ dir: root });
};
afterEach(() => {
    fileOps.renameSync = originalRename;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('外部平台草稿队列（ADR 0224）', () => {
    test('持久化状态必须和审计链最后一步一致，损坏的批准状态不能绕过人工确认', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const draft = seeded(0, 'pending');
        writeFileSync(join(root, 'drafts.json'), JSON.stringify({
            version: 1,
            drafts: [{ ...draft, status: 'approved', updatedAt: draft.createdAt }],
        }));
        const logs: string[] = [];
        const store = createExternalDraftStore({ dir: root, log: message => logs.push(message) });
        assert.deepEqual(store.list(), [], '不把缺少批准审计的记录当成已批准');
        assert.ok(readdirSync(root).some(name => name.startsWith('drafts.json.corrupt-')), '保留损坏原件供人工核对');
        assert.match(logs.join('\n'), /schema/);
    });

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

    test('状态时间不能倒退，拒绝后内存和磁盘仍保留原状态', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = createExternalDraftStore({ dir: root });
        const draft = store.create({ platform: 'tieba', title: '标题', body: '正文', at: new Date('2026-11-03T00:01:00.000Z') });
        assert.throws(
            () => store.updateStatus(draft.id, 'approved', '人工确认', new Date('2026-11-03T00:00:00.000Z')),
            /不能早于上一条审计/,
        );
        assert.equal(store.list()[0]!.status, 'pending');
        const reloaded = createExternalDraftStore({ dir: root }).list()[0]!;
        assert.equal(reloaded.status, 'pending');
        assert.equal(reloaded.audit.length, 1);
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

    test('队列满时只回收最老的已结束记录，不删除待确认草稿', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const statuses = Array.from({ length: MAX_EXTERNAL_DRAFTS }, (_, index): ExternalDraftStatus => index === 0 ? 'pending' : 'published');
        // 模拟迁移或人工核对后文件顺序被倒置；回收不能依赖数组位置。
        writeFileSync(join(root, 'drafts.json'), JSON.stringify({ version: 1, drafts: statuses.map((status, index) => seeded(index, status)).reverse() }));
        const store = createExternalDraftStore({ dir: root });
        store.create({ platform: 'douyin', title: '新草稿', body: '等待确认' });
        assert.equal(store.summary().total, MAX_EXTERNAL_DRAFTS);
        assert.ok(store.list({ status: 'pending', limit: 100 }).some(item => item.id === 'seed-0000'), '最老的待确认草稿必须保留');
        const saved = JSON.parse(readFileSync(join(root, 'drafts.json'), 'utf8')) as { drafts: ExternalDraft[] };
        assert.equal(saved.drafts.some(item => item.id === 'seed-0001'), false, '回收最老的已发布记录');
        assert.equal(saved.drafts.some(item => item.id === `seed-${String(MAX_EXTERNAL_DRAFTS - 1).padStart(4, '0')}`), true, '不能误删文件里排在前面的最新记录');
    });

    test('队列全是仍需处理的草稿时拒绝新增，不静默丢审计', () => {
        const root = mkdtempSync(join(tmpdir(), 'qqbot-external-drafts-')); roots.push(root);
        const store = seedStore(root, Array.from({ length: MAX_EXTERNAL_DRAFTS }, () => 'pending'));
        assert.throws(() => store.create({ platform: 'xiaohongshu', title: '超出的草稿', body: '不能覆盖旧草稿' }), /队列已满/);
        assert.equal(store.summary().total, MAX_EXTERNAL_DRAFTS);
        assert.equal(store.summary().pending, MAX_EXTERNAL_DRAFTS);
    });
});
