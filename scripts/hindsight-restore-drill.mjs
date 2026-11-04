// 只向名称受限的隔离 PostgreSQL 数据库导入；不会覆盖在线 Hindsight，也不会自动删除目标库。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { restoreDrillPlan } from './restore-drill-state.mjs';
import { isolatedDatabaseTarget, psqlConnectionArgs, safeSqlArtifact } from './hindsight-restore-state.mjs';

const args = process.argv.slice(2);
const one = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const backup = one('--backup');
const databaseUrl = one('--database-url') ?? process.env.QQBOT_RESTORE_DATABASE_URL;
if (!backup || !databaseUrl) throw new Error('用法：node scripts/hindsight-restore-drill.mjs --backup <完整备份目录> --database-url <隔离 PostgreSQL URL> --confirm-isolated [--plan]');
if (!args.includes('--confirm-isolated')) throw new Error('必须显式传入 --confirm-isolated');

const plan = restoreDrillPlan(resolve(backup));
const artifact = safeSqlArtifact(plan.database.path, plan.database.bytes);
const target = isolatedDatabaseTarget(databaseUrl);
console.log(`[hindsight-restore] 目标：${target.host}:${target.port}/${target.database}；备份 ${artifact.bytes} 字节`);
if (args.includes('--plan')) {
    console.log('[hindsight-restore] 计划验证通过；没有连接数据库。');
    process.exit(0);
}

const psql = one('--psql') ?? process.env.PSQL_BIN ?? 'psql';
const connection = psqlConnectionArgs(target);
const env = { ...process.env, ...(target.password ? { PGPASSWORD: target.password } : {}), ...(target.sslmode ? { PGSSLMODE: target.sslmode } : {}) };
const scalar = sql => execFileSync(psql, [...connection, '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const existing = Number(scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"));
if (!Number.isInteger(existing) || existing !== 0) throw new Error('隔离数据库不是空库，拒绝导入');
execFileSync(psql, [...connection, '-v', 'ON_ERROR_STOP=1', '-f', artifact.path], { env, timeout: 10 * 60_000, stdio: 'ignore' });
const restored = Number(scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"));
if (!Number.isInteger(restored) || restored < 1) throw new Error('导入结束但没有发现业务表');
console.log(`[hindsight-restore] 通过：隔离库中发现 ${restored} 张业务表。目标库已保留供人工核验，不会自动删除。`);
const report = one('--report');
if (report) {
    // 回执故意不记录连接串、主机、用户名或密码。
    writeFileSync(resolve(report), `${JSON.stringify({ version: 1, passed: true, checkedAt: new Date().toISOString(), backup: basename(resolve(backup)), isolatedDatabase: target.database, businessTables: restored }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
