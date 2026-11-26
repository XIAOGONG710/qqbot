// 更新检查：只看版本差异、更新前备份和回滚点，不下载、不执行 pull、不跑任何脚本。
// 真正的更新与应用走独立运维流程（docs/operations/upgrade.md），这里只回答「能不能快进」。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { COMPLETE_MARKER, backupHealth, isCompleteBackup } from './backup-state.mjs';

const LIST_LIMIT = 20;

function lines(text, limit = LIST_LIMIT) {
    return String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, limit);
}

export function createUpdateCheck({ root, runGit, now = () => Date.now() }) {
    const backups = resolve(root, 'runtime', 'backups');

    async function attempt(args) {
        try { return { ok: true, text: await runGit(args) }; } catch (error) { return { ok: false, error }; }
    }

    /** 远端只认 origin/main。为了能算差异，只把 main 取到 FETCH_HEAD，不动工作区和本地分支。 */
    async function remoteMain() {
        const listed = await attempt(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
        if (!listed.ok) return null;
        const sha = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/.exec(String(listed.text).trim())?.[1] ?? null;
        if (!sha) return null;
        const fetched = await attempt(['fetch', '--no-tags', '--quiet', 'origin', 'refs/heads/main']);
        if (!fetched.ok) return null;
        return (await attempt(['rev-parse', 'FETCH_HEAD'])).text?.trim() ?? null;
    }

    function backupState() {
        if (!existsSync(backups)) return { state: 'missing', latest: null };
        const days = [];
        for (const name of readdirSync(backups)) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(name) && existsSync(join(backups, name, COMPLETE_MARKER))) {
                days.push({ name, complete: isCompleteBackup(join(backups, name)) });
            }
        }
        days.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
        const latest = days.at(-1);
        if (!latest || !latest.complete) return { state: 'missing', latest: latest?.name ?? null };
        const today = new Date(now()).toISOString().slice(0, 10);
        const health = backupHealth(days, today);
        if (health?.reason === 'stale' || health?.reason === 'tiny-state') return { state: 'stale', latest: latest.name };
        return { state: 'fresh', latest: latest.name };
    }

    async function revision(ref) {
        const result = await attempt(['rev-parse', '--verify', ref]);
        const text = String(result.text ?? '').trim();
        return /^[0-9a-f]{40}$/.test(text) ? text : null;
    }

    /** 只看本地已知的两个提交：不 ls-remote、不 fetch、不 status，面板不点「检查远端」时用它 */
    async function known() {
        return { local: await revision('HEAD'), tracked: await revision('refs/remotes/origin/main') };
    }

    async function check() {
        const branch = (await attempt(['rev-parse', '--abbrev-ref', 'HEAD'])).text?.trim() ?? null;
        const local = await revision('HEAD');
        const tracked = await revision('refs/remotes/origin/main');
        const remote = await remoteMain();
        const dirty = lines((await attempt(['status', '--porcelain'])).text ?? '').length > 0;
        const backup = backupState();
        const blockers = [];
        if (branch !== 'main') blockers.push('not-main');
        if (dirty) blockers.push('dirty-tree');
        if (backup.state !== 'fresh') blockers.push('backup-stale');

        let relationship = 'unknown';
        let ahead = null;
        let behind = null;
        let commits = [];
        let changed = { count: 0, paths: [] };
        if (local && remote) {
            if (local === remote) {
                relationship = 'same';
                ahead = 0;
                behind = 0;
            } else {
                const forward = await attempt(['merge-base', '--is-ancestor', local, remote]);
                const backward = await attempt(['merge-base', '--is-ancestor', remote, local]);
                relationship = forward.ok ? 'behind' : backward.ok ? 'ahead' : 'diverged';
                if (relationship === 'diverged') blockers.push('diverged');
                behind = Number((await attempt(['rev-list', '--count', `${local}..${remote}`])).text?.trim() ?? 0) || 0;
                ahead = Number((await attempt(['rev-list', '--count', `${remote}..${local}`])).text?.trim() ?? 0) || 0;
                if (relationship === 'behind') {
                    commits = lines((await attempt(['log', '--format=%h %s', `${local}..${remote}`])).text)
                        .map(line => {
                            const at = line.indexOf(' ');
                            return at < 0 ? { short: line, subject: '' } : { short: line.slice(0, at), subject: line.slice(at + 1) };
                        });
                    const all = lines((await attempt(['diff', '--name-only', local, remote])).text, 10_000);
                    changed = { count: all.length, paths: all.slice(0, LIST_LIMIT) };
                }
            }
        } else if (!remote) {
            blockers.push('no-remote');
        }

        return {
            branch,
            local,
            tracked,
            remote,
            relationship,
            ahead,
            behind,
            commits,
            changed,
            tree: dirty ? 'dirty' : 'clean',
            backup,
            // 只给建议命令，不执行；更新和服务重载都在运维流程里手动做。
            commands: relationship === 'behind' ? ['git pull --ff-only'] : [],
            rollback: { commit: local, hint: `git checkout ${local ?? '<当前提交>'}` },
            canFastForward: blockers.length === 0 && relationship === 'behind',
            blockers,
        };
    }

    return { check, known };
}
