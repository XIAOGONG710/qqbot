import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const DESKTOP_STATE_DIRECTORY = 'dsh-state';
const SOUL_FILES = [
    'SOUL.md', 'SOUL.archive.md', 'SOUL.md.history.jsonl', 'PERSONA.md', 'LEDGER.md', 'LEDGER.md.history.jsonl', 'JOURNAL.md', 'PRIVATE.dat',
    'WISHES.md', 'INTERESTS.md', 'OFFLINE.json', 'HOME-PUBLIC.json', 'timeline-inbox.jsonl', 'world-inbox.jsonl',
    'self-receipts.jsonl', 'session-tails.jsonl', 'feeling-ledger.jsonl', 'RATINGS.json', 'REFUSALS.json',
];
const OUTBOX_NAMES = ['OUTBOX.jsonl', 'OUTBOX.jsonl.work', 'OUTBOX.jsonl.next'];
const ALLOWED = new Set([
    ...[...SOUL_FILES, ...OUTBOX_NAMES].map(name => `soul/${name}`),
    ...OUTBOX_NAMES.map(name => `outbox/${name}`), 'resident/jobs.json',
]);

export function desktopBackupFiles({ soulDir, residentDir, outboxFile }) {
    const canonicalOutbox = join(soulDir, 'OUTBOX.jsonl');
    const candidates = [...SOUL_FILES, ...OUTBOX_NAMES].map(name => [`soul/${name}`, join(soulDir, name)]);
    candidates.push(['resident/jobs.json', join(residentDir, 'jobs.json')]);
    if (outboxFile && resolve(outboxFile) !== resolve(canonicalOutbox)) {
        for (const suffix of ['', '.work', '.next']) candidates.push([`outbox/OUTBOX.jsonl${suffix}`, `${outboxFile}${suffix}`]);
    }
    return candidates.flatMap(([name, path]) => {
        let info;
        try { info = lstatSync(path); } catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`DSH 状态来源不是普通文件：${basename(name)}`);
        return [{ name, path }];
    });
}

export function configuredDesktopBackupFiles(env = process.env) {
    return desktopBackupFiles({
        soulDir: env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao'),
        residentDir: env.HER_DIR ?? join(homedir(), '.dsh', 'her'),
        outboxFile: env.QQBOT_OUTBOX,
    });
}

export function stageDesktopBackup(target, files) {
    const directory = join(target, DESKTOP_STATE_DIRECTORY);
    const names = [];
    for (const { name, path } of files) {
        if (!ALLOWED.has(name) || names.includes(name)) throw new Error('DSH 备份条目不受支持或重复');
        const output = join(directory, name);
        mkdirSync(dirname(output), { recursive: true });
        copyFileSync(path, output);
        names.push(name);
    }
    if (!names.length) return undefined;
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: 1, files: names.sort() }));
    return directory;
}

export function verifyDesktopBackup(directory, expectedCount) {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== expectedCount
        || new Set(manifest.files).size !== expectedCount || !manifest.files.every(name => ALLOWED.has(name))) {
        throw new Error('DSH 备份清单不完整或包含未知文件');
    }
    const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
    const found = new Set(entries.filter(entry => !entry.isDirectory()).map(entry =>
        join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll('\\', '/')));
    found.delete('manifest.json');
    if (found.size !== expectedCount || !manifest.files.every(name => found.has(name))) throw new Error('DSH 状态缺少备份清单中的文件');
    return expectedCount;
}
