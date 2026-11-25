// 备份恢复的四个阶段：制品校验、文件隔离恢复、隔离数据库恢复、正式切换。
// 前三个阶段都只写临时目录，可以离线反复演练；正式切换只给出运行手册里的步骤，
// 不在这里执行，等单独的上线授权。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { restoreDrillPlan, safeRestoreDrillTarget, verifyRestoredState } from './restore-drill-state.mjs';

export const STAGES = [
    { id: 'artifacts', label: '制品校验', writes: '不写盘' },
    { id: 'files', label: '文件隔离恢复', writes: '临时目录' },
    { id: 'database', label: '隔离数据库恢复', writes: '临时目录' },
    { id: 'switch', label: '正式切换', writes: '需要单独授权' },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DUMPS = new Set(['PGDMP', 'SET', 'CREA', '--']);

/** 默认不连任何数据库：只给出本机会怎么跑，交给运维在隔离环境里执行。 */
const dryRun = command => ({ executed: false, command });

function expandArchive(archive, destination) {
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(destination)} -Force`],
    { timeout: 10 * 60_000, stdio: 'ignore' });
}

function head(path, bytes = 8) {
    const buffer = readFileSync(path);
    return buffer.subarray(0, Math.min(bytes, buffer.length)).toString('latin1');
}

function digest(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

export function createRestoreStages({ root, run = dryRun, extract = expandArchive, now = () => new Date() }) {
    const backups = resolve(root, 'runtime', 'backups');
    const stamp = () => now().toISOString().replace(/[:.]/g, '-');

    function directory(day) {
        if (typeof day !== 'string' || !DAY.test(day)) throw new Error('备份日期格式不对');
        const backup = resolve(backups, day);
        if (!existsSync(backup)) throw new Error('这份备份不存在');
        return backup;
    }

    /** 阶段一：只读完成标记与制品本身，不展开任何东西。 */
    function artifacts(day) {
        try {
            const backup = directory(day);
            const plan = restoreDrillPlan(backup);
            return {
                ok: true,
                stage: 'artifacts',
                backup,
                database: { bytes: plan.database.bytes, digest: digest(plan.database.path) },
                state: { bytes: plan.state.bytes, source: plan.source, digest: digest(plan.state.path) },
            };
        } catch (error) {
            return { ok: false, stage: 'artifacts', error: error instanceof Error ? error.message : '制品校验失败' };
        }
    }

    /** 阶段二：把状态包解到隔离目录再只读检查；失败就把目录整个删掉。 */
    function files(day, options = {}) {
        let target;
        try {
            const plan = restoreDrillPlan(directory(day));
            target = safeRestoreDrillTarget(root, join(root, 'runtime', 'restore-drills', stamp()));
            mkdirSync(target, { recursive: true });
            extract(plan.state.path, target);
            const result = verifyRestoredState(target);
            const kept = options.keep === true;
            if (!kept) rmSync(target, { recursive: true, force: true });
            return { ok: true, stage: 'files', files: result.files, aiPhotos: result.aiPhotos, references: result.aiPhotoReferences, target: kept ? target : null };
        } catch (error) {
            if (target) rmSync(target, { recursive: true, force: true });
            return { ok: false, stage: 'files', error: error instanceof Error ? error.message : '文件隔离恢复失败' };
        }
    }

    /** 阶段三：把 dump 放进一次性的假库目录，只做头部校验和恢复命令预演。 */
    function database(day) {
        let work;
        try {
            const plan = restoreDrillPlan(directory(day));
            const header = head(plan.database.path, 5);
            if (!DUMPS.has(header) && !DUMPS.has(header.slice(0, 2))) throw new Error('数据库备份不是可识别的 dump');
            work = mkdtempSync(join(tmpdir(), 'hindsight-restore-'));
            const copy = join(work, 'hindsight.sql');
            cpSync(plan.database.path, copy);
            if (statSync(copy).size !== plan.database.bytes) throw new Error('复制到隔离目录后大小不一致');
            const outcome = run({
                database: 'hindsight_restore_drill',
                dump: copy,
                // 隔离库使用一次性名字，并且只允许出现在临时目录里。
                args: ['-v', 'ON_ERROR_STOP=1', '-d', 'hindsight_restore_drill', '-f', copy],
            });
            return { ok: true, stage: 'database', bytes: plan.database.bytes, header, isolated: outcome.executed === true ? 'executed' : 'planned' };
        } catch (error) {
            return { ok: false, stage: 'database', error: error instanceof Error ? error.message : '隔离数据库恢复失败' };
        } finally {
            if (work) rmSync(work, { recursive: true, force: true });
        }
    }

    /** 阶段四：不执行任何动作，只交出运行手册里的步骤。 */
    function switchPlan(day) {
        directory(day);
        return {
            ok: true,
            stage: 'switch',
            requiresApproval: true,
            executed: false,
            steps: [
                '确认本机与线上都在 main，且 备份、恢复演练、行为基线 三个检查都是绿的',
                '停掉线上服务（/休眠 或者运维手动停），确认没有新的写入',
                '把 runtime/bot 重命名成 runtime/bot.before-restore-<时间>，保留原样',
                '解压状态包到 runtime/bot，再按运行手册逐项核对文件数与 AI 照片草稿',
                '在隔离实例里恢复 hindsight.sql，核对记忆条数与最近一次对话，再切到正式库',
                '启动服务，看运维事件与召回诊断各 10 行，确认没有 failed',
                '确认无误后再删 bot.before-restore-* 与隔离实例；有异常就整体换回旧目录',
            ],
        };
    }

    return { stages: STAGES, artifacts, files, database, switchPlan };
}
