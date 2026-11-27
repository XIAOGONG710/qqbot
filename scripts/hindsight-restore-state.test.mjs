import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedDatabaseTarget, psqlConnectionArgs, safeSqlArtifact } from './hindsight-restore-state.mjs';

test('Hindsight 恢复只接受明确命名的隔离数据库，连接参数不含密码', () => {
    const target = isolatedDatabaseTarget('postgresql://drill:secret@127.0.0.1:5433/qqbot_restore_drill_20261104?sslmode=disable');
    assert.equal(target.database, 'qqbot_restore_drill_20261104');
    const args = psqlConnectionArgs(target);
    assert.deepEqual(args, ['-h', '127.0.0.1', '-p', '5433', '-U', 'drill', '-d', 'qqbot_restore_drill_20261104']);
    assert.doesNotMatch(JSON.stringify(args), /secret/);
    assert.throws(() => isolatedDatabaseTarget('postgresql://user@localhost/hindsight'), /qqbot_restore_drill_/);
});

test('Hindsight 恢复制品拒绝大小错配和符号链接', t => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-restore-sql-'));
    try {
        const sql = join(dir, 'hindsight.sql');
        writeFileSync(sql, 'select 1;');
        assert.equal(safeSqlArtifact(sql, 9).bytes, 9);
        assert.throws(() => safeSqlArtifact(sql, 8), /大小/);
        let link = join(dir, 'linked.sql');
        try { symlinkSync(sql, link, 'file'); }
        catch (error) {
            if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
            link = process.env.QQBOT_TEST_EXISTING_FILE_SYMLINK;
            if (!link) return t.skip('当前 Windows 账户不能创建符号链接，且未提供现有文件符号链接');
        }
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        assert.throws(() => safeSqlArtifact(link), /普通文件/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
