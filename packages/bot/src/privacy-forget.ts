// 联系人数据的导出与遗忘（ADR 0070 第 9 项），建立在 privacy-audit 的清单上。
// 原则：默认只演练（--apply 才动）；本地文件不直接删，先移进 runtime 下的回收目录，能挪回去；
// bot 在跑（单实例锁被活着的进程持有）时拒绝执行；混在别人数据里的文件（日志、生活账、档位记录）不碰，只列出来；
// Hindsight 的删除目标是这个联系人自己的 bank、公共库里以他的哈希开头的文档和他的印象模型，删完要让人复查。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from './lock.ts';
import { HindsightClient, HindsightError } from './memory/hindsight.ts';
import { auditContactPrivacy, type PrivacyAudit } from './privacy-audit.ts';
import { writeJsonAtomic } from './json-file.ts';
import { readDiaryState } from './diary-state.ts';
import type { ProvenanceEntry } from './memory/provenance.ts';

/** Hindsight 里要删的东西的最小接口（测试给假的） */
export interface ForgetApi {
    activeOperations?(bankId: string): Promise<string[]>;
    deleteBank(bankId: string): Promise<void>;
    deleteDocument(bankId: string, documentId: string): Promise<void>;
    deleteMentalModel(bankId: string, modelId: string): Promise<void>;
}

export interface ForgetPlan {
    qq: number;
    /** 会被移进回收目录的本地文件（相对数据目录） */
    move: string[];
    /** 默认保留、需人复核的混合文件；--include-derived 可回收关联日记中的命中日期。 */
    leave: { path: string; references?: number; note: string }[];
    hindsight: { banks: string[]; commonBank: string; documents: string[]; mentalModels: string[] };
    trackedDocuments: { bankId: string; documentId: string }[];
    /** 联合派生内容可能包含别人：默认仅列出，--include-derived 才按整篇处理。 */
    derived: ProvenanceEntry[];
    limitations: string[];
}

export function planForget(audit: PrivacyAudit, commonBank: string): ForgetPlan {
    return {
        qq: audit.qq,
        move: audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path),
        leave: audit.artifacts.filter(item => item.kind === 'mixed').map(item => ({ path: item.path, ...(item.references !== undefined ? { references: item.references } : {}), note: item.note })),
        hindsight: { banks: audit.hindsight.banks, commonBank: audit.hindsight.commonBank ?? commonBank, documents: audit.hindsight.commonDocuments, mentalModels: audit.hindsight.commonMentalModels },
        trackedDocuments: audit.hindsight.trackedDocuments,
        derived: audit.hindsight.derivedDocuments,
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

export interface ForgetResult { plan: ForgetPlan; applied: boolean; trash?: string; moved: string[]; archivedDiaryDates: string[]; deleted: { banks: string[]; documents: string[]; mentalModels: string[] }; failures: string[] }

function archiveDerivedDiary(root: string, trash: string, derived: readonly ProvenanceEntry[]): string[] {
    const dates = [...new Set(derived.filter(e => e.kind === 'diary' && /^diary:\d{4}-\d{2}-\d{2}$/.test(e.documentId)).map(e => e.documentId.slice(6)))];
    const path = join(root, 'memory', 'diary.json');
    if (!dates.length || !existsSync(path)) return [];
    const state = readDiaryState(path);
    const texts = state.texts;
    const selected = Object.fromEntries(dates.filter(d => typeof texts[d] === 'string').map(d => [d, texts[d]]));
    // 先回收命中的原文，绝不导出联合文件里无关的其他日期。
    writeJsonAtomic(join(trash, 'derived-diary.json'), { version: 1, texts: selected });
    for (const date of dates) delete texts[date];
    state.texts = texts;
    state.forgotten = { ...state.forgotten, ...Object.fromEntries(dates.map(d => [d, true])) };
    writeJsonAtomic(path, state);
    return dates;
}

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
    options: { apply: boolean; trashDir: string; commonBank: string; api?: ForgetApi; includeDerived?: boolean; now?: Date; isAlive?: (pid: number) => boolean },
): Promise<ForgetResult> {
    const root = resolve(dataDir);
    const plan = planForget(auditContactPrivacy(root, qq), options.commonBank);
    const result: ForgetResult = { plan, applied: false, moved: [], archivedDiaryDates: [], deleted: { banks: [], documents: [], mentalModels: [] }, failures: [] };
    if (!options.apply) return result;
    const running = botRunning(root, options.isAlive);
    if (running !== undefined) throw new Error(`bot 还在运行（PID ${running}）：先停掉再清理，否则它会把数据重新写回去`);
    if (plan.derived.length && !options.includeDerived) throw new Error('存在关联的联合日记/总结；先审查 derived 清单，明确同意整篇处理后加 --include-derived');
    if (plan.derived.some(e => e.retention !== 'local-only') && !options.api) throw new Error('关联派生内容可能已写入 Hindsight；必须提供 --hindsight 才能处理，不能只清掉本地原文');
    const diaryPath = join(root, 'memory', 'diary.json');
    if (options.includeDerived && plan.derived.some(e => e.kind === 'diary') && existsSync(diaryPath)) {
        // 先验证本地遗忘状态，不能先删远端再发现本地关键标记已经损坏。
        readDiaryState(diaryPath);
    }
    if (options.api?.activeOperations) {
        const banks = new Set([
            ...plan.hindsight.banks,
            ...(plan.hindsight.documents.length || plan.hindsight.mentalModels.length ? [plan.hindsight.commonBank] : []),
            ...plan.trackedDocuments.map(e => e.bankId),
            ...plan.derived.filter(e => e.retention !== 'local-only').map(e => e.bankId),
        ]);
        for (const bank of banks) {
            if ((await options.api.activeOperations(bank)).length) throw new Error(`Hindsight ${bank} 仍有排队/执行中的后台操作，等待其结束后再清理，避免旧写入复活`);
        }
    }

    result.applied = true;
    mkdirSync(resolve(options.trashDir), { recursive: true });
    const trash = mkdtempSync(join(resolve(options.trashDir), `${qq}-${stamp(options.now ?? new Date())}-`));
    result.trash = trash;
    const checkpoint = () => writeJsonAtomic(join(trash, 'forget-report.json'), result);
    checkpoint();
    if (options.api) {
        const attempt = async (what: string, list: string[], sink: string[], run: (item: string) => Promise<void>) => {
            for (const item of list) {
                try {
                    await run(item);
                    sink.push(item);
                } catch (error) {
                    result.failures.push(`删除${what} ${item} 失败：${error instanceof Error ? error.message : String(error)}`);
                }
                checkpoint();
            }
        };
        const targets = [...new Map([
            ...plan.hindsight.documents.map(documentId => ({ bankId: plan.hindsight.commonBank, documentId })),
            ...plan.trackedDocuments,
            ...(options.includeDerived ? plan.derived.filter(e => e.retention !== 'local-only').map(e => ({ bankId: e.bankId, documentId: e.documentId })) : []),
        ].map(e => [JSON.stringify([e.bankId, e.documentId]), e])).values()];
        for (const target of targets) {
            await attempt('文档', [target.documentId], result.deleted.documents, id => options.api!.deleteDocument(target.bankId, id));
        }
        await attempt('印象模型', plan.hindsight.mentalModels, result.deleted.mentalModels, id => options.api!.deleteMentalModel(plan.hindsight.commonBank, id));
        await attempt('私人记忆库', plan.hindsight.banks, result.deleted.banks, id => options.api!.deleteBank(id));
    }
    // 远端任一步失败，保留本地原文与进度，使下次运行仍能重建完整目标并幂等重试。
    if (!result.failures.length) {
        if (options.includeDerived) {
            try { result.archivedDiaryDates = archiveDerivedDiary(root, trash, plan.derived); }
            catch (error) { result.failures.push(`回收关联日记失败：${error instanceof Error ? error.message : String(error)}`); }
            checkpoint();
        }
        if (!result.failures.length) for (const file of plan.move) {
            try {
                const target = join(trash, file);
                mkdirSync(dirname(target), { recursive: true });
                renameSync(join(root, file), target);
                result.moved.push(file);
            } catch (error) {
                result.failures.push(`移动 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
            checkpoint();
        }
    }
    checkpoint();
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
        includeDerived: args.includes('--include-derived'),
        trashDir: resolve(base, option('--trash') ?? join(data, '..', 'privacy-trash')),
        commonBank: `${prefix}-common`,
        ...(api ? { api } : {}),
    }).then(result => {
        console.log(JSON.stringify(result, null, 2));
        console.log(result.applied ? `已尝试处理，失败 ${result.failures.length} 项；本地回收和逐步报告位于 ${result.trash}。请按报告核对哪些文件实际已移动；Hindsight 需再跑 privacy-audit 和 recall 复查。` : '这是演练，什么都没动；确认清单后加 --apply（先停 bot），联合派生内容需另加 --include-derived。');
        if (result.failures.length) process.exitCode = 1;
    }).catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

/** HindsightClient 的删除方法（文档和印象模型不存在算已经删了） */
export function hindsightForgetApi(client: HindsightClient): ForgetApi {
    return {
        activeOperations: async id => {
            try { return await client.activeOperations(id); }
            catch (error) { if (error instanceof HindsightError && error.status === 404) return []; throw error; }
        },
        deleteBank: id => client.deleteBank(id),
        deleteDocument: (bank, id) => client.deleteDocument(bank, id),
        deleteMentalModel: (bank, id) => client.deleteMentalModel(bank, id),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
