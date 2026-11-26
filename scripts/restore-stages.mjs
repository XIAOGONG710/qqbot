// 备份恢复的四个阶段：制品校验、文件隔离恢复、隔离数据库恢复、正式切换。
// 前三个阶段都只写临时目录，可以离线反复演练；正式切换只给出运行手册里的步骤，
// 不在这里执行，等单独的上线授权。
// 这些阶段在 DSH 面板进程里跑：解压、读 dump、算摘要、复制都走异步和流式，不能卡住面板的事件循环（审查第 7 条）。
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { restoreDrillPlan, safeRestoreDrillTarget, verifyRestoredState } from './restore-drill-state.mjs';
import { checkBackupDigest } from './backup-integrity.mjs';

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
        // 不用 Expand-Archive：CI（windows-latest）上它不管带不带 -Force 都调不存在的三参数 ExtractToDirectory
        //（「Cannot find an overload for "ExtractToDirectory" and the argument count: "3"」，11-27）。直接用 .NET 4.5 起都有的两参数版本；
        // 它遇到指向目标目录外面的条目会拒绝。目标是刚 mkdtemp 出来的空目录，路径都是绝对路径。
        `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quoted(archive)}, ${quoted(destination)})`],
    { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
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

/** 阶段结果只带固定的错误码（审查第 15 条）：原始 message 常带本机路径，只写进本机日志，不交给面板 */
export const STAGE_ERRORS = ['invalid_day', 'backup_missing', 'artifact_invalid', 'extract_failed', 'restored_state_invalid',
    'not_a_dump', 'size_mismatch', 'stage_failed'];

class StageError extends Error {
    constructor(code, cause) {
        super(code, cause === undefined ? undefined : { cause });
        this.code = code;
    }
}

/** 跑一步，出错就换成这一步的错误码；已经是 StageError 的原样往外抛 */
async function step(code, work) {
    try { return await work(); } catch (error) {
        throw error instanceof StageError ? error : new StageError(code, error);
    }
}

export function createRestoreStages({ root, run = dryRun, extract = expandArchive, now = () => new Date(), log = () => {} }) {
    const backups = resolve(root, 'runtime', 'backups');
    const stamp = () => now().toISOString().replace(/[:.]/g, '-');

    function directory(day) {
        if (typeof day !== 'string' || !DAY.test(day)) throw new StageError('invalid_day');
        const backup = resolve(backups, day);
        if (!existsSync(backup)) throw new StageError('backup_missing');
        return backup;
    }

    const planOf = day => step('artifact_invalid', () => restoreDrillPlan(directory(day), { verifyDigest: false }));
    const verify = (artifact, path = artifact.path) => step('artifact_invalid', async () =>
        (await checkBackupDigest(path, artifact.sha256)).slice(0, 16));

    function failed(stage, error) {
        const code = error instanceof StageError ? error.code : 'stage_failed';
        const cause = error instanceof StageError ? error.cause : error;
        // 子进程失败时 message 第一行只是命令本身，真正的报错在 stderr：带上第一行有内容的（只进本机日志）
        const stderr = typeof cause?.stderr === 'string' ? cause.stderr.split('\n').map(line => line.trim()).find(Boolean) : undefined;
        if (cause !== undefined) log(`${stage} ${code}: ${String(cause?.message ?? cause).split('\n')[0].slice(0, 300)}${stderr ? ` | stderr: ${stderr.slice(0, 300)}` : ''}`);
        return { ok: false, stage, error: code };
    }

    /** 阶段一：只读完成标记与制品本身，不展开任何东西。 */
    async function artifacts(day) {
        try {
            const plan = await planOf(day);
            return {
                ok: true,
                stage: 'artifacts',
                day,
                database: { bytes: plan.database.bytes, digest: await verify(plan.database) },
                state: { bytes: plan.state.bytes, source: plan.source, digest: await verify(plan.state) },
            };
        } catch (error) {
            return failed('artifacts', error);
        }
    }

    /** 阶段二：把状态包解到隔离目录再只读检查；失败就把目录整个删掉。 */
    async function files(day, options = {}) {
        let target;
        try {
            const plan = await planOf(day);
            if (plan.state.sha256) await verify(plan.state);
            if (plan.database.sha256) await verify(plan.database);
            const prefix = safeRestoreDrillTarget(root, join(root, 'runtime', 'restore-drills', `${stamp()}-`));
            mkdirSync(dirname(prefix), { recursive: true });
            target = await mkdtemp(prefix);
            await step('extract_failed', () => extract(plan.state.path, target));
            const result = await step('restored_state_invalid', () => verifyRestoredState(target, plan.desktopFiles));
            const kept = options.keep === true;
            if (!kept) await rm(target, { recursive: true, force: true });
            // 留下的演练目录只给仓库里的相对路径，不给本机绝对路径
            return { ok: true, stage: 'files', files: result.files, aiPhotos: result.aiPhotos, references: result.aiPhotoReferences,
                ...(result.desktopFiles !== undefined ? { desktopFiles: result.desktopFiles } : {}),
                target: kept ? `runtime/restore-drills/${basename(target)}` : null };
        } catch (error) {
            if (target) await rm(target, { recursive: true, force: true });
            return failed('files', error);
        }
    }

    /** 阶段三：把 dump 放进一次性的假库目录，只做头部校验和恢复命令预演。 */
    async function database(day) {
        let work;
        try {
            const plan = await planOf(day);
            const header = await step('artifact_invalid', () => head(plan.database.path, 5));
            if (!DUMPS.has(header) && !DUMPS.has(header.slice(0, 2))) throw new StageError('not_a_dump');
            work = await mkdtemp(join(tmpdir(), 'hindsight-restore-'));
            const copy = join(work, 'hindsight.sql');
            await copyFile(plan.database.path, copy);
            if ((await stat(copy)).size !== plan.database.bytes) throw new StageError('size_mismatch');
            if (plan.database.sha256) await verify(plan.database, copy);
            const outcome = await run({
                database: 'hindsight_restore_drill',
                dump: copy,
                // 隔离库使用一次性名字，并且只允许出现在临时目录里。
                args: ['-v', 'ON_ERROR_STOP=1', '-d', 'hindsight_restore_drill', '-f', copy],
            });
            return { ok: true, stage: 'database', bytes: plan.database.bytes, header, isolated: outcome.executed === true ? 'executed' : 'planned' };
        } catch (error) {
            return failed('database', error);
        } finally {
            if (work) await rm(work, { recursive: true, force: true });
        }
    }

    /** 阶段四：不执行任何动作，只交出运行手册里的步骤。 */
    function switchPlan(day) {
        // 找不到备份就明说，不抛错：面板据此回 404，不让请求的 Promise 被拒绝（审查第 6 条）
        try { directory(day); } catch (error) { return { ok: false, stage: 'switch', error: error.code ?? 'backup_missing' }; }
        return {
            ok: true,
            stage: 'switch',
            requiresApproval: true,
            executed: false,
            steps: [
                '确认本机与线上都在 main，且 备份、恢复演练、行为基线 三个检查都是绿的',
                '停掉线上服务（/休眠 或者运维手动停），确认没有新的写入',
                '保留 Koishi 配置指定的数据目录和 DSH / 常驻原目录副本',
                '按运行手册将状态包与 dsh-state 各自放回对应目录，再核对清单和 AI 照片草稿',
                '在隔离实例里恢复 hindsight.sql，核对记忆条数与最近一次对话，再切到正式库',
                '启动服务，看运维事件与召回诊断各 10 行，确认没有 failed',
                '确认无误后再删 bot.before-restore-* 与隔离实例；有异常就整体换回旧目录',
            ],
        };
    }

    return { stages: STAGES, artifacts, files, database, switchPlan };
}
