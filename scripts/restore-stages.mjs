// 备份恢复的四个阶段：制品校验、文件隔离恢复、隔离数据库恢复、正式切换。
// 前三个阶段都只写临时目录，可以离线反复演练；正式切换只给出运行手册里的步骤，
// 不在这里执行，等单独的上线授权。
// 这些阶段在 DSH 面板进程里跑：解压、读 dump、算摘要、复制都走异步和流式，不能卡住面板的事件循环（审查第 7 条）。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

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

const execFileAsync = promisify(execFile);

async function expandArchive(archive, destination) {
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(destination)} -Force`],
    { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 64 * 1024 });
}

/** 只读文件头几个字节，不为了 5 个字节把整份 dump 读进内存 */
async function head(path, bytes = 8) {
    const handle = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead).toString('latin1');
    } finally { await handle.close(); }
}

/** 流式算摘要，几百 MB 的 dump 也只占一小块缓冲 */
async function digest(path) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex').slice(0, 16);
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
    async function artifacts(day) {
        try {
            const backup = directory(day);
            const plan = restoreDrillPlan(backup);
            return {
                ok: true,
                stage: 'artifacts',
                backup,
                database: { bytes: plan.database.bytes, digest: await digest(plan.database.path) },
                state: { bytes: plan.state.bytes, source: plan.source, digest: await digest(plan.state.path) },
            };
        } catch (error) {
            return { ok: false, stage: 'artifacts', error: error instanceof Error ? error.message : '制品校验失败' };
        }
    }

    /** 阶段二：把状态包解到隔离目录再只读检查；失败就把目录整个删掉。 */
    async function files(day, options = {}) {
        let target;
        try {
            const plan = restoreDrillPlan(directory(day));
            target = safeRestoreDrillTarget(root, join(root, 'runtime', 'restore-drills', stamp()));
            mkdirSync(target, { recursive: true });
            await extract(plan.state.path, target);
            const result = verifyRestoredState(target);
            const kept = options.keep === true;
            if (!kept) await rm(target, { recursive: true, force: true });
            return { ok: true, stage: 'files', files: result.files, aiPhotos: result.aiPhotos, references: result.aiPhotoReferences, target: kept ? target : null };
        } catch (error) {
            if (target) await rm(target, { recursive: true, force: true });
            return { ok: false, stage: 'files', error: error instanceof Error ? error.message : '文件隔离恢复失败' };
        }
    }

    /** 阶段三：把 dump 放进一次性的假库目录，只做头部校验和恢复命令预演。 */
    async function database(day) {
        let work;
        try {
            const plan = restoreDrillPlan(directory(day));
            const header = await head(plan.database.path, 5);
            if (!DUMPS.has(header) && !DUMPS.has(header.slice(0, 2))) throw new Error('数据库备份不是可识别的 dump');
            work = await mkdtemp(join(tmpdir(), 'hindsight-restore-'));
            const copy = join(work, 'hindsight.sql');
            await copyFile(plan.database.path, copy);
            if ((await stat(copy)).size !== plan.database.bytes) throw new Error('复制到隔离目录后大小不一致');
            const outcome = await run({
                database: 'hindsight_restore_drill',
                dump: copy,
                // 隔离库使用一次性名字，并且只允许出现在临时目录里。
                args: ['-v', 'ON_ERROR_STOP=1', '-d', 'hindsight_restore_drill', '-f', copy],
            });
            return { ok: true, stage: 'database', bytes: plan.database.bytes, header, isolated: outcome.executed === true ? 'executed' : 'planned' };
        } catch (error) {
            return { ok: false, stage: 'database', error: error instanceof Error ? error.message : '隔离数据库恢复失败' };
        } finally {
            if (work) await rm(work, { recursive: true, force: true });
        }
    }

    /** 阶段四：不执行任何动作，只交出运行手册里的步骤。 */
    function switchPlan(day) {
        // 找不到备份就明说，不抛错：面板据此回 404，不让请求的 Promise 被拒绝（审查第 6 条）
        try { directory(day); } catch { return { ok: false, stage: 'switch', error: 'backup_missing' }; }
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
