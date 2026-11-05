// 联系人数据的导出与遗忘（ADR 0070 第 9 项），建立在 privacy-audit 的清单上。
// 原则：默认只演练（--apply 才动）；本地文件不直接删，先移进 runtime 下的回收目录，能挪回去；
// bot 在跑（单实例锁被活着的进程持有）时拒绝执行；混在别人数据里的文件（日志、生活账、档位记录）不碰，只列出来；
// Hindsight 的删除目标是这个联系人自己的 bank、公共库里以他的哈希开头的文档和他的印象模型，删完要让人复查。

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, isProcessAlive } from '../platform/lock.ts';
import { HindsightClient } from '.././memory/hindsight.ts';
import { memoryLedger, recordForget } from './memory-audit.ts';
import { auditContactPrivacy, type PrivacyAudit } from './privacy-audit.ts';
import { describeError } from './transient-io.ts';
import { writeJsonAtomic } from './json-file.ts';
import { assertForgetPath, createForgetJob, forgetFilePath, loadForgetJob, sameForgetFile, saveForgetJob, unfinishedForgetJobs, type ForgetJob } from './forget-job.ts';

/** Hindsight 里要删的东西的最小接口（测试给假的） */
export interface ForgetApi {
    deleteBank(bankId: string): Promise<void>;
    deleteDocument(bankId: string, documentId: string): Promise<void>;
    deleteMentalModel(bankId: string, modelId: string): Promise<void>;
}

export interface ForgetPlan {
    qq: number;
    /** 会被移进回收目录的本地文件（相对数据目录） */
    move: string[];
    /** 不碰、需要人复核的混合文件 */
    leave: { path: string; references?: number; note: string }[];
    hindsight: { banks: string[]; commonBank: string; documents: string[]; mentalModels: string[]; commonTargets?: { bankId: string; documents: string[]; mentalModels: string[] }[] };
    limitations: string[];
}

export function planForget(audit: PrivacyAudit, commonBank: string): ForgetPlan {
    return {
        qq: audit.qq,
        move: audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path),
        leave: audit.artifacts.filter(item => item.kind === 'mixed').map(item => ({ path: item.path, ...(item.references !== undefined ? { references: item.references } : {}), note: item.note })),
        hindsight: { banks: audit.hindsight.banks, commonBank, documents: audit.hindsight.commonDocuments, mentalModels: audit.hindsight.commonMentalModels, ...(audit.hindsight.commonTargets ? { commonTargets: audit.hindsight.commonTargets } : {}) },
        limitations: audit.limitations,
    };
}

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

/** 原子预留独立批次；同秒或并发操作不能覆盖之前的恢复资料。 */
function batchDir(root: string, name: string): string {
    const parent = resolve(root);
    // 不允许调用方的回收/导出目录通过已有链接把写入引到别处。
    for (let part = parent; part !== dirname(part); part = dirname(part)) {
        if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('导出或回收目录包含链接，未执行');
    }
    mkdirSync(parent, { recursive: true });
    for (let n = 1;; n++) {
        const dir = join(parent, `${name}${n === 1 ? '' : `-${n}`}`);
        try { mkdirSync(dir); return dir; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('导出或回收目录无法创建，未执行'); }
    }
}

/** 导出：把这个联系人的本地专属文件原样复制一份，另附清单；不改任何东西 */
export function exportContact(dataDir: string, qq: number, outDir: string, now = new Date()): { dir: string; files: string[]; audit: PrivacyAudit } {
    const root = resolve(dataDir);
    unfinishedForgetJobs(root);
    const audit = auditContactPrivacy(root, qq);
    const dir = batchDir(outDir, `${qq}-${stamp(now)}`);
    const files = audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path);
    for (const file of files) {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, file), target);
    }
    writeFileSync(join(dir, 'audit.json'), JSON.stringify(audit, null, 2));
    return { dir, files, audit };
}

export interface ForgetResult { plan: ForgetPlan; applied: boolean; trash?: string; jobId?: string; complete?: boolean; moved: string[]; deleted: { banks: string[]; documents: string[]; mentalModels: string[] }; failures: string[] }

/** 被活着的 bot 持有的锁：有就不执行（数据目录里的 bot.lock） */
export function botRunning(dataDir: string, isAlive = isProcessAlive): number | undefined {
    const path = join(resolve(dataDir), 'bot.lock');
    if (!existsSync(path)) return undefined;
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
}

export async function forgetContact(
    dataDir: string,
    qq: number,
    options: { apply: boolean; trashDir: string; commonBank: string; api?: ForgetApi; now?: Date; isAlive?: (pid: number) => boolean;
        /** Resume exactly this durable plan, without discovering new targets. */
        resume?: string;
        /** CLI endpoint binding. Hash only; no URL/key is stored in the job. */
        remoteScope?: string;
        /** CLI audit must finish while the maintenance lock is still held. */
        recordAudit?: boolean },
): Promise<ForgetResult> {
    const root = resolve(dataDir);
    const empty = (plan: ForgetPlan): ForgetResult => ({ plan, applied: false, moved: [], deleted: { banks: [], documents: [], mentalModels: [] }, failures: [] });
    if (!Number.isSafeInteger(qq) || qq <= 0) throw new Error('qq 应为正整数');
    if (!options.apply) {
        // Read-only does not need a lease, but must not silently ignore corrupt jobs.
        unfinishedForgetJobs(root);
        if (options.resume) {
            const job = loadForgetJob(root, options.resume);
            if (job.plan.qq !== qq) throw new Error('遗忘任务联系人不匹配，未执行');
            return { ...empty(job.plan), jobId: job.id, trash: job.trash, complete: job.complete };
        }
        return empty(planForget(auditContactPrivacy(root, qq), options.commonBank));
    }
    assertForgetPath(root); mkdirSync(root, { recursive: true });
    const running = botRunning(root, options.isAlive);
    if (running !== undefined) throw new Error(`bot 还在运行（PID ${running}）：先停掉再清理，否则它会把数据重新写回去`);
    // Atomic lease is the authority. The preceding check only preserves the old
    // friendly diagnostic; audit and every mutation happen after acquiring it.
    const release = acquireLock(join(root, 'bot.lock'), process.pid, options.isAlive);
    try {
        const pending = unfinishedForgetJobs(root);
        let job: ForgetJob;
        if (options.resume) {
            job = loadForgetJob(root, options.resume);
            if (job.plan.qq !== qq || job.remoteScope !== options.remoteScope) throw new Error('遗忘任务联系人或远端绑定不匹配，未执行');
            if (pending.some(id => id !== job.id)) throw new Error('存在其他未完成遗忘任务；请先按原任务恢复');
            if (job.remoteEnabled && !options.api) throw new Error('此遗忘任务需要原远端接口，未执行');
        } else {
            if (pending.length) throw new Error(`存在未完成遗忘任务（${pending.join(',')}）；请使用 --resume 原任务UUID，不重新生成目标`);
            const plan = planForget(auditContactPrivacy(root, qq), options.commonBank);
            const trash = batchDir(options.trashDir, `${qq}-${stamp(options.now ?? new Date())}`);
            job = createForgetJob(root, plan, trash, options.api !== undefined, options.remoteScope);
        }
        const result: ForgetResult = { ...empty(job.plan), applied: true, trash: job.trash, jobId: job.id, complete: job.complete };
        const refreshResult = () => {
            result.moved = [...job.moved]; result.complete = job.complete;
            result.deleted = { banks: [], documents: [], mentalModels: [] };
            for (const item of job.remote.filter(r => r.state === 'done')) {
                (item.kind === 'bank' ? result.deleted.banks : item.kind === 'document' ? result.deleted.documents : result.deleted.mentalModels).push(item.id ?? item.bank);
            }
        };
        if (job.complete) { refreshResult(); return result; }
        for (const file of job.files) {
            try {
                const source = forgetFilePath(root, file.path), target = forgetFilePath(job.trash, file.path);
                if (existsSync(source)) {
                    if (job.moved.includes(file.path) || existsSync(target) || !sameForgetFile(source, file)) throw new Error('原件已变化或恢复目标冲突');
                    mkdirSync(dirname(target), { recursive: true }); renameSync(source, target);
                }
                // Confirms a rename that completed before crash/checkpoint failure.
                if (!existsSync(target) || !sameForgetFile(target, file)) throw new Error('恢复资料缺失或已变化');
                if (!job.moved.includes(file.path)) { job.moved.push(file.path); saveForgetJob(root, job); }
            } catch (error) { result.failures.push(`移动 ${file.path} 失败：${describeError(error)}`); }
        }
        // A failed move must not turn a fresh source into an orphaned remote delete.
        if (result.failures.length === 0) for (const item of job.remote) {
            if (item.state === 'done') continue;
            const what = item.kind === 'bank' ? '私人记忆库' : item.kind === 'document' ? '文档' : '印象模型';
            if (item.state !== 'pending') {
                result.failures.push(`删除${what} ${item.id ?? item.bank} 结果未确认；原任务保留，不能安全自动重试`); continue;
            }
            item.state = 'dispatching'; saveForgetJob(root, job);
            let failure: unknown; let failed = false;
            try {
                if (item.kind === 'bank') await options.api!.deleteBank(item.bank);
                else if (item.kind === 'document') await options.api!.deleteDocument(item.bank, item.id!);
                else await options.api!.deleteMentalModel(item.bank, item.id!);
            } catch (error) { failed = true; failure = error; }
            const status = failure instanceof Error && 'status' in failure && Number.isSafeInteger(failure.status) ? failure.status as number : undefined;
            if (!failed || status === 404) item.state = 'done';
            else {
                // 5xx may originate in a proxy while upstream still executes.
                // Neither timeout nor a status alone proves that DELETE stopped.
                item.state = 'uncertain';
                result.failures.push(`删除${what} ${item.id ?? item.bank} 失败：${status === undefined ? describeError(failure) : `HTTP ${status}`}；结果未确认，原任务保留`);
            }
            saveForgetJob(root, job);
        }
        refreshResult();
        const report = join(job.trash, 'forget-report.json'); assertForgetPath(report);
        writeJsonAtomic(report, result);
        if (options.recordAudit) recordForget(memoryLedger(root), qq, result);
        if (result.failures.length === 0 && job.moved.length === job.files.length && job.remote.every(r => r.state === 'done')) {
            job.complete = true; saveForgetJob(root, job); result.complete = true;
            writeJsonAtomic(report, result);
        }
        return result;
    } finally { release(); }
}

function main(): void {
    const args = process.argv.slice(2);
    const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
    const [command] = args;
    const dataDir = option('--data');
    const qq = Number(option('--qq'));
    if (!['export', 'forget'].includes(command ?? '') || !dataDir || !Number.isInteger(qq) || qq <= 0) {
        console.error('用法：\n  node src/privacy-forget.ts export --data <数据目录> --qq <QQ号> [--out <导出目录>]\n  node src/privacy-forget.ts forget --data <数据目录> --qq <QQ号> [--trash <回收目录>] [--hindsight <地址>] [--bank-prefix <前缀>] [--resume <原任务UUID>] [--apply]\n默认只演练；forget --apply 要先停 bot；带 --hindsight 才会动 Hindsight。结果未知的远端删除保留屏障，不能盲目重试。');
        process.exitCode = 2;
        return;
    }
    const base = process.env.INIT_CWD ?? process.cwd();
    const data = resolve(base, dataDir);
    if (command === 'export') {
        const out = resolve(base, option('--out') ?? join(data, '..', 'privacy-export'));
        const { dir, files } = exportContact(data, qq, out);
        console.log(`已导出 ${files.length} 个文件到 ${dir}（含 audit.json）；没有删除任何东西。`);
        return;
    }
    const prefix = option('--bank-prefix') ?? 'qqbot';
    const url = option('--hindsight');
    const api: ForgetApi | undefined = url ? hindsightForgetApi(new HindsightClient(url, 30_000)) : undefined;
    void forgetContact(data, qq, {
        apply: args.includes('--apply'),
        trashDir: resolve(base, option('--trash') ?? join(data, '..', 'privacy-trash')),
        commonBank: `${prefix}-common`,
        ...(api ? { api } : {}),
        ...(url ? { remoteScope: createHash('sha256').update(url.replace(/\/+$/, '')).digest('hex') } : {}),
        ...(option('--resume') ? { resume: option('--resume')! } : {}),
        recordAudit: true,
    }).then(result => {
        console.log(JSON.stringify(result, null, 2));
        console.log(result.applied ? `${result.complete ? '已处理' : '尚未完成，原任务与启动屏障保留'}；本地恢复资料在 ${result.trash}。恢复前请核实原任务及远端结果，仅挪回文件不代表未确认删除已经停止。Hindsight 删完请再跑一次 privacy-audit 和 recall 复查。` : '这是演练，什么都没动；确认清单后加 --apply（先停 bot）。');
        if (result.failures.length) process.exitCode = 1;
    }).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

/** HindsightClient 的删除方法（文档和印象模型不存在算已经删了） */
export function hindsightForgetApi(client: HindsightClient): ForgetApi {
    return {
        deleteBank: id => client.deleteBank(id),
        deleteDocument: (bank, id) => client.deleteDocument(bank, id),
        deleteMentalModel: (bank, id) => client.deleteMentalModel(bank, id),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
