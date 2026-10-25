// 联系人数据的导出与遗忘（ADR 0070 第 9 项），建立在 privacy-audit 的清单上。
// 原则：默认只演练（--apply 才动）；本地文件不直接删，先移进 runtime 下的回收目录，能挪回去；
// bot 在跑（单实例锁被活着的进程持有）时拒绝执行；混在别人数据里的文件（日志、生活账、档位记录）不碰，只列出来；
// Hindsight 的删除目标是这个联系人自己的 bank、公共库里以他的哈希开头的文档和他的印象模型，删完要让人复查。

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from './lock.ts';
import { HindsightClient } from './memory/hindsight.ts';
import { memoryLedger, recordForget } from './memory-audit.ts';
import { auditContactPrivacy, type PrivacyAudit } from './privacy-audit.ts';

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
    hindsight: { banks: string[]; commonBank: string; documents: string[]; mentalModels: string[] };
    limitations: string[];
}

export function planForget(audit: PrivacyAudit, commonBank: string): ForgetPlan {
    return {
        qq: audit.qq,
        move: audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path),
        leave: audit.artifacts.filter(item => item.kind === 'mixed').map(item => ({ path: item.path, ...(item.references !== undefined ? { references: item.references } : {}), note: item.note })),
        hindsight: { banks: audit.hindsight.banks, commonBank, documents: audit.hindsight.commonDocuments, mentalModels: audit.hindsight.commonMentalModels },
        limitations: audit.limitations,
    };
}

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');

/** 导出：把这个联系人的本地专属文件原样复制一份，另附清单；不改任何东西 */
export function exportContact(dataDir: string, qq: number, outDir: string, now = new Date()): { dir: string; files: string[]; audit: PrivacyAudit } {
    const root = resolve(dataDir);
    const audit = auditContactPrivacy(root, qq);
    const dir = join(resolve(outDir), `${qq}-${stamp(now)}`);
    mkdirSync(dir, { recursive: true });
    const files = audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path);
    for (const file of files) {
        const target = join(dir, file);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, file), target);
    }
    writeFileSync(join(dir, 'audit.json'), JSON.stringify(audit, null, 2));
    return { dir, files, audit };
}

export interface ForgetResult { plan: ForgetPlan; applied: boolean; trash?: string; moved: string[]; deleted: { banks: string[]; documents: string[]; mentalModels: string[] }; failures: string[] }

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
    options: { apply: boolean; trashDir: string; commonBank: string; api?: ForgetApi; now?: Date; isAlive?: (pid: number) => boolean },
): Promise<ForgetResult> {
    const root = resolve(dataDir);
    const plan = planForget(auditContactPrivacy(root, qq), options.commonBank);
    const result: ForgetResult = { plan, applied: false, moved: [], deleted: { banks: [], documents: [], mentalModels: [] }, failures: [] };
    if (!options.apply) return result;
    const running = botRunning(root, options.isAlive);
    if (running !== undefined) throw new Error(`bot 还在运行（PID ${running}）：先停掉再清理，否则它会把数据重新写回去`);

    result.applied = true;
    const trash = join(resolve(options.trashDir), `${qq}-${stamp(options.now ?? new Date())}`);
    result.trash = trash;
    for (const file of plan.move) {
        try {
            const target = join(trash, file);
            mkdirSync(dirname(target), { recursive: true });
            renameSync(join(root, file), target);
            result.moved.push(file);
        } catch (error) {
            result.failures.push(`移动 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    mkdirSync(trash, { recursive: true });
    if (options.api) {
        const attempt = async (what: string, list: string[], sink: string[], run: (item: string) => Promise<void>) => {
            for (const item of list) {
                try {
                    await run(item);
                    sink.push(item);
                } catch (error) {
                    result.failures.push(`删除${what} ${item} 失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        };
        await attempt('文档', plan.hindsight.documents, result.deleted.documents, id => options.api!.deleteDocument(plan.hindsight.commonBank, id));
        await attempt('印象模型', plan.hindsight.mentalModels, result.deleted.mentalModels, id => options.api!.deleteMentalModel(plan.hindsight.commonBank, id));
        await attempt('私人记忆库', plan.hindsight.banks, result.deleted.banks, id => options.api!.deleteBank(id));
    }
    writeFileSync(join(trash, 'forget-report.json'), JSON.stringify({ ...result, plan }, null, 2));
    return result;
}

function main(): void {
    const args = process.argv.slice(2);
    const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
    const [command] = args;
    const dataDir = option('--data');
    const qq = Number(option('--qq'));
    if (!['export', 'forget'].includes(command ?? '') || !dataDir || !Number.isInteger(qq) || qq <= 0) {
        console.error('用法：\n  node src/privacy-forget.ts export --data <数据目录> --qq <QQ号> [--out <导出目录>]\n  node src/privacy-forget.ts forget --data <数据目录> --qq <QQ号> [--trash <回收目录>] [--hindsight <地址>] [--bank-prefix <前缀>] [--apply]\n默认只演练；forget --apply 要先停 bot；带 --hindsight 才会动 Hindsight。');
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
    }).then(result => {
        // 真删了的才记进记忆账本（ADR 0158）：只记 id 和数量，不记内容
        if (result.applied) recordForget(memoryLedger(data), qq, result);
        console.log(JSON.stringify(result, null, 2));
        console.log(result.applied ? `已处理；本地文件移到 ${result.trash}，要恢复就挪回去。Hindsight 删完请再跑一次 privacy-audit 和 recall 复查。` : '这是演练，什么都没动；确认清单后加 --apply（先停 bot）。');
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
