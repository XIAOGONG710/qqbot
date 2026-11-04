import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { auditAiPhotoStorage } from '../src/vision/ai-photo-storage.ts';
import { checkStates } from '../src/ops/state-check.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-storage-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'files'), { recursive: true });
    return dir;
};

const entry = (id: string, patch: Record<string, unknown> = {}) => ({
    id, eventKey: `event-${id}`, kind: 'view', subject: '窗外', caption: '窗外',
    at: '2026-09-01T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z',
    file: `${id}.jpg`, status: 'pending_review', model: 'test', promptHash: 'a'.repeat(64),
    ...patch,
});

describe('AI 照片草稿存储审计（ADR 0246）', () => {
    test('合法索引和文件通过；审计保持只读', () => {
        const dir = fresh();
        const id = '111111111111';
        writeFileSync(join(dir, 'files', `${id}.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [entry(id)] }));
        const before = readFileSync(join(dir, 'index.json'), 'utf8');
        const report = auditAiPhotoStorage(dir, { now: new Date('2026-11-04T00:00:00.000Z') });
        assert.deepEqual(report, { indexPresent: true, entries: 1, files: 1, issues: [], cleanup: [], dryRun: true });
        assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before);
    });

    test('缺图、孤立文件和路径错配会失败；只把安全普通孤立文件列入预览', () => {
        const dir = fresh();
        const orphan = '222222222222.jpg';
        writeFileSync(join(dir, 'files', orphan), 'orphan');
        writeFileSync(join(dir, 'files', 'note.txt'), 'do not delete');
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [
            entry('111111111111'),
            entry('333333333333', { file: '444444444444.jpg' }),
        ] }));
        const report = auditAiPhotoStorage(dir);
        assert.deepEqual(report.issues.map(issue => issue.code).sort(), ['entry_file_invalid', 'entry_file_missing', 'orphan_file', 'unexpected_file']);
        assert.deepEqual(report.cleanup, [{ kind: 'orphan_file', id: '222222222222', file: orphan }]);
        assert.ok(report.issues.every(issue => !('path' in issue)), '不返回绝对路径');
    });

    test('过期拒绝项只进入清理预览，不会自动修改索引或文件', () => {
        const dir = fresh();
        const oldId = '111111111111';
        const freshId = '222222222222';
        for (const id of [oldId, freshId]) writeFileSync(join(dir, 'files', `${id}.jpg`), 'image');
        const index = JSON.stringify({ version: 1, entries: [
            entry(oldId, { status: 'rejected', reviewedAt: '2026-09-01T00:00:00.000Z' }),
            entry(freshId, { status: 'rejected', reviewedAt: '2026-10-25T00:00:00.000Z' }),
        ] });
        writeFileSync(join(dir, 'index.json'), index);
        const report = auditAiPhotoStorage(dir, { now: new Date('2026-11-04T00:00:00.000Z'), rejectedRetentionDays: 30 });
        assert.deepEqual(report.cleanup, [{ kind: 'rejected_entry', id: oldId, file: `${oldId}.jpg`, reviewedAt: '2026-09-01T00:00:00.000Z' }]);
        assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), index);
        assert.equal(readFileSync(join(dir, 'files', `${oldId}.jpg`), 'utf8'), 'image');
    });

    test('图片目录符号链接失败关闭，不读取链接目标也不给清理候选', () => {
        const dir = fresh();
        const outside = mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-outside-'));
        dirs.push(outside);
        writeFileSync(join(outside, '222222222222.jpg'), 'outside');
        rmSync(join(dir, 'files'), { recursive: true });
        symlinkSync(outside, join(dir, 'files'), 'junction');
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [entry('222222222222')] }));

        const report = auditAiPhotoStorage(dir);
        assert.deepEqual(report.issues.map(issue => issue.code), ['files_symlink', 'entry_file_missing']);
        assert.deepEqual(report.cleanup, []);
        assert.equal(report.files, 0);
    });

    test('状态检查在副本中识别缺图和孤立文件，原目录不变', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-ai-photo-state-check-'));
        dirs.push(dataDir);
        const dir = join(dataDir, 'ai-photo-drafts');
        mkdirSync(join(dir, 'files'), { recursive: true });
        writeFileSync(join(dir, 'files', '222222222222.jpg'), 'orphan');
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: [entry('111111111111')] }));
        const check = checkStates(dataDir).find(item => item.name === 'AI 照片草稿存储')!;
        assert.equal(check.ok, false);
        assert.match(check.detail, /entry_file_missing/);
        assert.match(check.detail, /orphan_file/);
        assert.equal(readFileSync(join(dir, 'files', '222222222222.jpg'), 'utf8'), 'orphan');
    });
});

