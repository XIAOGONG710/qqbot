// 每天一份备份（F3，2026-11-02）：Hindsight 的数据库 + 她的聊天记录和状态文件。
// 为什么：Hindsight 一年挂几次（11-02 挂了一整天都没人发现），她的记忆只在那一个 Postgres 里；
// 聊天记录和状态文件也只有这一份。备份放在 runtime/backups/，保留 7 天。
//
// 用法：
//   node scripts/backup.mjs            # 今天没有就做一份（服务守护每天调一次）
//   node scripts/backup.mjs --now      # 强制做一份
//   node scripts/backup.mjs --retry-now --keep-old  # 立即补做缺失部分，保留旧备份
//
// 依赖：pg_dump（在 .pg0 的安装目录里）、powershell 的 Compress-Archive。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
    COMPLETE_MARKER,
    FAILURE_MARKER,
    backupDirectoriesToPrune,
    configuredDataDir,
    discoverStateBackup,
    isCompleteBackup,
    isReusableBackupArtifact,
    retryDue,
    stateBackupDisposition,
    writeBackupMarker,
} from './backup-state.mjs';

const root = process.cwd();
const backupDir = join(root, 'runtime', 'backups');
const keepDays = 7;
const stamp = new Date();
const day = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
const target = join(backupDir, day);
const force = process.argv.includes('--now');
const retryNow = process.argv.includes('--retry-now');
const keepOld = process.argv.includes('--keep-old');

const log = (message) => console.log(`[backup] ${message}`);

function pgDump(reuse) {
    const out = join(target, 'hindsight.sql');
    if (reuse) {
        log('数据库已有可用备份，本次只重试缺失部分');
        return { ok: true, reused: true, bytes: statSync(out).size };
    }
    const bin = join(homedir(), '.pg0', 'installation', '18.1.0', 'bin', 'pg_dump.exe');
    if (!existsSync(bin)) {
        log('没找到 pg_dump，跳过数据库（Hindsight 的记忆这次没备份）');
        return { ok: false, reason: 'pg_dump_missing' };
    }
    try {
        execFileSync(bin, ['-h', '127.0.0.1', '-p', '5433', '-U', 'hindsight', '-d', 'hindsight', '-f', out], {
            env: { ...process.env, PGPASSWORD: process.env.QQBOT_HINDSIGHT_DB_PASSWORD ?? 'hindsight' },
            timeout: 10 * 60_000,
            stdio: 'ignore',
        });
        const bytes = statSync(out).size;
        const size = (bytes / 1024 / 1024).toFixed(1);
        log(`数据库备份好：hindsight.sql（${size} MB）`);
        return { ok: true, bytes };
    } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
        log(`数据库备份失败：${reason}`);
        return { ok: false, reason };
    }
}

function archiveState(reuse, plan) {
    // 状态和聊天记录（都不大，几百 MB 以内）；日志不备（没价值、还占地方）
    const disposition = stateBackupDisposition(plan);
    if (disposition === 'missing') {
        log('没有状态数据目录，本次只备份数据库');
        return { ok: true, skipped: true };
    }
    if (disposition === 'invalid') {
        log(`状态数据路径 ${plan.source} 不是可读取的目录，拒绝把这次备份标成完成`);
        return { ok: false, source: plan.source, reason: 'state_invalid' };
    }
    if (disposition === 'empty') {
        log(`状态数据目录 ${plan.source} 是空的，拒绝把这次备份标成完成`);
        return { ok: false, source: plan.source, reason: 'state_empty' };
    }
    const zip = join(target, 'her-state.zip');
    if (reuse) {
        log('状态已有可用备份，本次只重试缺失部分');
        return { ok: true, reused: true, source: plan.source, bytes: statSync(zip).size };
    }
    try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command',
            `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${plan.items.map(item => `'${item.replace(/'/g, "''")}'`).join(',')} -DestinationPath '${zip.replace(/'/g, "''")}' -Force`],
        { timeout: 10 * 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const bytes = statSync(zip).size;
        log(`状态打包好：her-state.zip（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
        return { ok: true, source: plan.source, bytes };
    } catch (error) {
        const diagnostic = error?.stderr?.trim().split(/\r?\nAt (?:line:|[^\r\n]+:\d+ char:)/)[0];
        const reason = diagnostic?.replace(/\r?\n\s*/g, ' ')
            || (error instanceof Error ? error.message.split('\n')[0] : String(error));
        log(`状态打包失败：${reason}`);
        return { ok: false, reason };
    }
}

function prune() {
    if (!existsSync(backupDir)) return;
    const dirs = readdirSync(backupDir).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
    const complete = dirs.filter(name => isCompleteBackup(join(backupDir, name)));
    for (const name of backupDirectoriesToPrune(dirs, complete, day, keepDays)) {
        rmSync(join(backupDir, name), { recursive: true, force: true });
        log(`删掉旧备份 ${name}`);
    }
}

const dataDir = configuredDataDir(root);
log(dataDir ? `数据目录按 Koishi 配置：${dataDir}` : '没读到 Koishi 配置里的 dataDir，按 runtime/bot、runtime/bot-shadow 的顺序找');
const statePlan = discoverStateBackup(root, dataDir);
if (!force && isCompleteBackup(target, statePlan?.source ?? null)) {
    log(`今天已经有备份了（${day}），跳过`);
    process.exit(0);
}
if (!force && !retryNow && existsSync(target) && !retryDue(target)) {
    log('上次备份不完整，30 分钟后再重试');
    process.exit(0);
}
const reuseDatabase = !force && isReusableBackupArtifact(target, 'database', 'hindsight.sql');
const reuseState = !force && statePlan && isReusableBackupArtifact(
    target,
    'state',
    'her-state.zip',
    { source: statePlan.source },
);
mkdirSync(target, { recursive: true });
// 一旦开始新尝试，旧的完成标记就不能再证明即将被覆盖的文件有效。
rmSync(join(target, COMPLETE_MARKER), { force: true });
const database = pgDump(reuseDatabase);
const state = archiveState(reuseState, statePlan);
const attemptedAt = new Date().toISOString();
const components = { database, state };
if (database.ok && state.ok) {
    writeBackupMarker(target, COMPLETE_MARKER, { completed: true, completedAt: attemptedAt, components });
    rmSync(join(target, FAILURE_MARKER), { force: true });
} else {
    writeBackupMarker(target, FAILURE_MARKER, { completed: false, attemptedAt, components });
}
if (!keepOld) prune();
if (database.ok && state.ok) {
    log(`完成：${target}`);
} else {
    log(`未完成：${target}（保留已成功部分，稍后重试）`);
    process.exitCode = 1;
}
