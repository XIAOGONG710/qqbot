import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { DESKTOP_STATE_DIRECTORY, stageDesktopBackup } from './backup-desktop-state.mjs';
import { backupArtifactIdentity } from './backup-integrity.mjs';

export function archiveStateSnapshot(zip, plan, desktopFiles) {
    if (plan.items.some(path => basename(path).toLowerCase() === DESKTOP_STATE_DIRECTORY)) {
        throw new Error('状态目录占用了 DSH 备份保留名称');
    }
    const staging = mkdtempSync(join(tmpdir(), 'qqbot-backup-desktop-'));
    const part = `${zip}.${process.pid}.part.zip`;
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    try {
        const desktop = stageDesktopBackup(staging, desktopFiles);
        const items = desktop ? [...plan.items, desktop] : plan.items;
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath ${items.map(quote).join(',')} -DestinationPath ${quote(part)} -Force`],
        { timeout: 10 * 60_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const identity = backupArtifactIdentity(part);
        renameSync(part, zip);
        return { ...identity, desktopFiles: desktopFiles.length };
    } finally {
        rmSync(part, { force: true });
        rmSync(staging, { recursive: true, force: true });
    }
}
