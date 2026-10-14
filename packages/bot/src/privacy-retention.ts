// 本地运行日志保留工具：期限由操作者明确给出；默认演练，apply 只回收，不不可逆删除。
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { botRunning } from './privacy-forget.ts';
import { writeJsonAtomic } from './json-file.ts';

export interface RetentionPolicy { version: 1; logsDays: number }
export interface RetentionPlan {
    policy: RetentionPolicy;
    asOf: string;
    cutoff: string;
    files: { path: string; bytes: number }[];
    limitations: string[];
}

function dateNumber(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须为 YYYY-MM-DD');
    const at = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date) throw new Error('无效日期');
    return at;
}

function outside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

/** 日志按文件名里的本地日历日期计算，不信任 mtime（复制/恢复会改变 mtime）。 */
export function planRetention(dataDir: string, policy: RetentionPolicy, asOf: string): RetentionPlan {
    if (policy.version !== 1 || !Number.isSafeInteger(policy.logsDays) || policy.logsDays < 1 || policy.logsDays > 36500) throw new Error('logsDays 必须是 1–36500 的整数，未知版本拒绝执行');
    const cutoff = new Date(dateNumber(asOf) - policy.logsDays * 86_400_000).toISOString().slice(0, 10);
    const root = resolve(dataDir);
    const logDir = join(root, 'logs');
    const files: RetentionPlan['files'] = [];
    if (existsSync(logDir)) {
        if (lstatSync(logDir).isSymbolicLink() || !lstatSync(logDir).isDirectory()) throw new Error('logs 必须是实际目录，不能通过链接跨目录回收');
        // 仅处理日志组件直接生成的文件，不递归进入用户归档或链接。
        for (const entry of readdirSync(logDir, { withFileTypes: true })) {
            const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
            if (!entry.isFile() || entry.isSymbolicLink() || !match) continue;
            try { dateNumber(match[1]!); } catch { continue; }
            if (match[1]! >= cutoff) continue;
            const path = join(logDir, entry.name);
            files.push({ path: relative(root, path), bytes: statSync(path).size });
        }
    }
    return {
        policy, asOf, cutoff, files: files.sort((a, b) => a.path.localeCompare(b.path)),
        limitations: [
            '只覆盖 dataDir/logs 下按日期命名的运行日志，不删除聊天记录或记忆写入进度。',
            'apply 将过期文件移进指定的外部回收目录，原文仍可恢复；不等于彻底删除。',
            '导出、回收目录、系统备份及远端供应商的保留期需单独管理；此工具不自动扫描或清空它们。',
        ],
    };
}

export async function retainLocalLogs(dataDir: string, policy: RetentionPolicy, options: {
    asOf: string; apply?: boolean; archiveDir?: string; isAlive?: (pid: number) => boolean;
}): Promise<{ plan: RetentionPlan; applied: boolean; archive?: string; moved: string[]; failures: string[] }> {
    const root = resolve(dataDir);
    const plan = planRetention(root, policy, options.asOf);
    const result = { plan, applied: false, moved: [] as string[], failures: [] as string[], archive: undefined as string | undefined };
    if (!options.apply) return result;
    if (botRunning(root, options.isAlive) !== undefined) throw new Error('bot 还在运行：先停掉再执行日志回收');
    if (!options.archiveDir) throw new Error('apply 必须明确提供 --archive 回收目录');
    const parent = resolve(options.archiveDir);
    if (!outside(root, parent)) throw new Error('回收目录必须位于数据目录之外');
    mkdirSync(parent, { recursive: true });
    if (!outside(realpathSync(root), realpathSync(parent))) throw new Error('回收目录链接解析后落在数据目录内，拒绝执行');
    result.archive = mkdtempSync(join(parent, `logs-${options.asOf}-`));
    result.applied = true;
    const save = () => writeJsonAtomic(join(result.archive!, 'retention-report.json'), result);
    save();
    for (const file of plan.files) {
        const source = join(root, file.path);
        try {
            // 回收前再次检查，防止计划生成后文件被替换成链接。
            const stat = lstatSync(source);
            const logDir = join(root, 'logs');
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || lstatSync(logDir).isSymbolicLink()
                || outside(realpathSync(root), realpathSync(logDir))
                || !realpathSync(source).startsWith(`${realpathSync(logDir)}${sep}`)) throw new Error('日志在计划后已变化或不在目标目录');
            renameSync(source, join(result.archive, file.path.split(/[\\/]/).at(-1)!));
            result.moved.push(file.path);
        } catch (error) { result.failures.push(`${file.path}：${error instanceof Error ? error.message : String(error)}`); }
        save();
    }
    return result;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    const data = option('--data');
    if (!data || !option('--logs-days')) throw new Error('用法：privacy-retention --data <目录> --logs-days <天数> [--as-of YYYY-MM-DD] [--archive <外部回收目录> --apply]；默认演练');
    const now = new Date();
    const asOf = option('--as-of') ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const base = process.env.INIT_CWD ?? process.cwd();
    const archive = option('--archive');
    const result = await retainLocalLogs(resolve(base, data), { version: 1, logsDays: Number(option('--logs-days')) }, {
        asOf, apply: args.includes('--apply'), ...(archive ? { archiveDir: resolve(base, archive) } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
