import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { COMPLETE_MARKER, writeBackupMarker } from './backup-state.mjs';
import { restoreDrillPlan, safeRestoreDrillTarget, verifyRestoredState } from './restore-drill-state.mjs';

const roots = [];
const fresh = () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-restore-drill-'));
    roots.push(root);
    return root;
};

afterEach(() => {
    while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function completeBackup(root) {
    const database = 'database backup';
    const state = 'state archive';
    writeFileSync(join(root, 'hindsight.sql'), database);
    writeFileSync(join(root, 'her-state.zip'), state);
    writeBackupMarker(root, COMPLETE_MARKER, {
        completed: true,
        components: {
            database: { ok: true, bytes: Buffer.byteLength(database) },
            state: { ok: true, source: 'runtime/bot', bytes: Buffer.byteLength(state) },
        },
    });
}

test('恢复演练只接受带大小记录且制品一致的完整备份', () => {
    const root = fresh();
    completeBackup(root);
    const plan = restoreDrillPlan(root);
    assert.equal(plan.source, 'runtime/bot');
    writeFileSync(join(root, 'her-state.zip'), 'truncated');
    assert.throws(() => restoreDrillPlan(root), /状态备份与完成标记不一致/);
});

test('没有状态归档的数据库单独备份不能冒充完整恢复演练', () => {
    const root = fresh();
    writeFileSync(join(root, 'hindsight.sql'), 'database backup');
    writeBackupMarker(root, COMPLETE_MARKER, {
        completed: true,
        components: { database: { ok: true, bytes: 15 }, state: { ok: true, skipped: true } },
    });
    assert.throws(() => restoreDrillPlan(root), /没有状态归档/);
});

test('演练目标只能在隔离目录中且必须为空', () => {
    const root = fresh();
    const safe = join(root, 'runtime', 'restore-drills', 'one');
    assert.equal(safeRestoreDrillTarget(root, safe), safe);
    assert.throws(() => safeRestoreDrillTarget(root, join(root, 'runtime', 'bot')), /restore-drills/);
    mkdirSync(safe, { recursive: true });
    writeFileSync(join(safe, 'old.txt'), 'old');
    assert.throws(() => safeRestoreDrillTarget(root, safe), /必须为空/);
});

test('演练目标拒绝经过符号链接或目录联接', t => {
    const root = fresh();
    const outside = fresh();
    mkdirSync(join(root, 'runtime'), { recursive: true });
    try { symlinkSync(outside, join(root, 'runtime', 'restore-drills'), 'junction'); }
    catch (error) {
        if (error?.code === 'EPERM') return t.skip('当前 Windows 账户没有创建目录联接的权限');
        throw error;
    }
    assert.throws(
        () => safeRestoreDrillTarget(root, join(root, 'runtime', 'restore-drills', 'one')),
        /符号链接或目录联接/,
    );
});

test('解压结果检查 AI 照片索引、文件哈希和敏感目录', () => {
    const root = fresh();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('fake-image-content')]);
    const id = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    mkdirSync(join(root, 'ai-photo-drafts', 'files'), { recursive: true });
    writeFileSync(join(root, 'ai-photo-drafts', 'files', `${id}.jpg`), bytes);
    writeFileSync(join(root, 'ai-photo-drafts', 'index.json'), JSON.stringify({
        version: 1,
        entries: [{ id, file: `${id}.jpg` }],
    }));
    assert.deepEqual(verifyRestoredState(root), { files: 2, aiPhotos: { present: true, entries: 1 } });

    mkdirSync(join(root, 'secrets'));
    writeFileSync(join(root, 'secrets', 'token'), 'secret');
    assert.throws(() => verifyRestoredState(root), /敏感或临时内容/);
});

