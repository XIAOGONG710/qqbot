import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createUpdateCheck } from './update-check.mjs';

const NOW = () => Date.parse('2026-11-25T10:00:00Z');
const TODAY = '2026-11-25';

function git(cwd, args) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.test',
            GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.test',
            GIT_TERMINAL_PROMPT: '0',
        },
    }).trim();
}

function commit(cwd, file, text, message) {
    mkdirSync(join(cwd, file, '..'), { recursive: true });
    writeFileSync(join(cwd, file), text);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-m', message]);
    return git(cwd, ['rev-parse', 'HEAD']);
}

/** 造一个本地假远端：裸仓库 + 一条 main + 一份工作副本。 */
function environment() {
    const base = mkdtempSync(join(tmpdir(), 'update-check-'));
    const origin = join(base, 'origin.git');
    const seed = join(base, 'seed');
    const work = join(base, 'work');
    mkdirSync(origin, { recursive: true });
    git(origin, ['init', '--bare', '--initial-branch=main']);
    mkdirSync(seed, { recursive: true });
    git(seed, ['init', '--initial-branch=main']);
    commit(seed, '.gitignore', 'runtime/\n', '忽略运行时目录');
    commit(seed, 'docs/a.md', 'one\n', '第一条提交');
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(base, ['clone', origin, work]);
    return { base, origin, seed, work };
}

function freshBackup(work, day = TODAY, bytes = 12) {
    const target = join(work, 'runtime', 'backups', day);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'hindsight.sql'), 'PGDMP'.padEnd(bytes, 'x'));
    writeFileSync(join(target, 'her-state.zip'), 'PK\u0003\u0004'.padEnd(bytes, 'y'));
    writeFileSync(join(target, '.complete.json'), JSON.stringify({
        completed: true,
        components: {
            database: { ok: true, bytes },
            state: { ok: true, bytes, source: 'runtime/bot' },
        },
    }));
}

function spy(work) {
    const calls = [];
    const runGit = async args => {
        calls.push(args.join(' '));
        return git(work, args);
    };
    return { calls, runGit, check: createUpdateCheck({ root: work, runGit, now: NOW }) };
}

test('远端领先：给出差异、提交列表和回滚点，只建议快进', async () => {
    const { base, seed, work } = environment();
    try {
        freshBackup(work);
        commit(seed, 'docs/b.md', 'two\n', '远端第二条');
        commit(seed, 'scripts/c.mjs', 'export const x = 1\n', '远端第三条');
        git(seed, ['push', 'origin', 'main']);
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.branch, 'main');
        assert.equal(result.relationship, 'behind');
        assert.equal(result.behind, 2);
        assert.equal(result.ahead, 0);
        assert.deepEqual(result.commits.map(item => item.subject), ['远端第三条', '远端第二条']);
        assert.equal(result.changed.count, 2);
        assert.ok(result.changed.paths.includes('docs/b.md'));
        assert.equal(result.tree, 'clean');
        assert.equal(result.backup.state, 'fresh');
        assert.equal(result.canFastForward, true);
        assert.deepEqual(result.commands, ['git pull --ff-only']);
        assert.match(result.rollback.hint, /^git checkout [0-9a-f]{40}$/);
        assert.deepEqual(result.blockers, []);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('分支不是 main 就不许快进', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work);
        git(work, ['checkout', '-b', 'feature']);
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.branch, 'feature');
        assert.ok(result.blockers.includes('not-main'));
        assert.equal(result.canFastForward, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('工作区有没提交的改动就不许快进', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work);
        writeFileSync(join(work, 'dirty.txt'), 'x');
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.tree, 'dirty');
        assert.ok(result.blockers.includes('dirty-tree'));
        assert.equal(result.canFastForward, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('没有今天的新备份，先提示备份再更新', async () => {
    const { base, work } = environment();
    try {
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.backup.state, 'missing');
        assert.ok(result.blockers.includes('backup-stale'));
        assert.equal(result.canFastForward, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('备份是三天前的，同样算过期', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work, '2026-11-21');
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.backup.state, 'stale');
        assert.ok(result.blockers.includes('backup-stale'));
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('本地领先：不提示更新，也不给 pull 命令', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work);
        commit(work, 'docs/local.md', 'local\n', '本地提交');
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.relationship, 'ahead');
        assert.equal(result.ahead, 1);
        assert.equal(result.behind, 0);
        assert.deepEqual(result.commands, []);
        assert.equal(result.canFastForward, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('两边各有提交算分叉，挡下来交给人', async () => {
    const { base, seed, work } = environment();
    try {
        freshBackup(work);
        commit(work, 'docs/local.md', 'local\n', '本地提交');
        commit(seed, 'docs/remote.md', 'remote\n', '远端提交');
        git(seed, ['push', 'origin', 'main']);
        git(work, ['fetch', 'origin']);
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.relationship, 'diverged');
        assert.ok(result.blockers.includes('diverged'));
        assert.equal(result.canFastForward, false);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('没有远端时只报 no-remote，不发任何会改写仓库的命令', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work);
        git(work, ['remote', 'remove', 'origin']);
        const { check, calls } = spy(work);
        const result = await check.check();
        assert.equal(result.remote, null);
        assert.ok(result.blockers.includes('no-remote'));
        for (const call of calls) {
            // fetch 只更新 FETCH_HEAD，可以接受；pull / merge / rebase / reset / checkout 一律不发。
            assert.ok(!/(^|\s)(pull|merge|rebase|reset|checkout|clean)(\s|$)/.test(call), `不该执行：${call}`);
        }
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('已经是同一个提交：无事可做', async () => {
    const { base, work } = environment();
    try {
        freshBackup(work);
        const { check } = spy(work);
        const result = await check.check();
        assert.equal(result.relationship, 'same');
        assert.equal(result.behind, 0);
        assert.equal(result.canFastForward, false);
        assert.deepEqual(result.commands, []);
    } finally { rmSync(base, { recursive: true, force: true }); }
});
