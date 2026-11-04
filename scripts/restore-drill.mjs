// 文件级恢复演练：验证完整标记和制品大小，把状态包解压到隔离目录并做只读检查。
// 不连接 PostgreSQL、不覆盖 runtime/bot、不重启服务；默认验证后删除演练目录。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { restoreDrillPlan, safeRestoreDrillTarget, verifyRestoredState } from './restore-drill-state.mjs';

const root = process.cwd();
const backups = resolve(root, 'runtime', 'backups');
const arg = name => {
    const at = process.argv.indexOf(name);
    return at >= 0 ? process.argv[at + 1] : undefined;
};
const inside = (parent, child) => {
    const rel = relative(resolve(parent), resolve(child));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
};
const quoted = value => `'${value.replace(/'/g, "''")}'`;

let backup = arg('--backup');
if (!backup) {
    const latest = existsSync(backups)
        ? readdirSync(backups).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort().at(-1)
        : undefined;
    if (!latest) throw new Error('没有可用于演练的备份；可用 --backup 指定 runtime/backups 下的日期目录');
    backup = join(backups, latest);
}
backup = resolve(backup);
if (!inside(backups, backup)) throw new Error('恢复演练只接受 runtime/backups 下的备份目录');
const plan = restoreDrillPlan(backup);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = safeRestoreDrillTarget(root, arg('--target') ?? join(root, 'runtime', 'restore-drills', stamp));
mkdirSync(target, { recursive: true });

try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${quoted(plan.state.path)} -DestinationPath ${quoted(target)} -Force`],
    { timeout: 10 * 60_000, stdio: 'ignore' });
    const result = verifyRestoredState(target);
    console.log(`[restore-drill] 通过：数据库备份 ${plan.database.bytes} 字节；状态 ${result.files} 个文件；AI 照片草稿 ${result.aiPhotos.present ? `${result.aiPhotos.entries} 条` : '无'}；视觉参考 ${result.aiPhotoReferences.present ? `${result.aiPhotoReferences.entries} 条 / ${result.aiPhotoReferences.localFiles} 张本地图` : '无'}`);
    console.log('[restore-drill] 本次只验证文件级恢复；数据库仍需在隔离 PostgreSQL 中另做导入演练。');
} finally {
    if (!process.argv.includes('--keep')) rmSync(target, { recursive: true, force: true });
    else console.log(`[restore-drill] 演练目录保留在 ${target}`);
}

