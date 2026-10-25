// 设定被改时有记录 + 完整性校验（ADR 0157，配置 identityLedger，默认关）。
// 来自 10-25 用户给的清单：「人格自主权：核心人格设定原则上由你决定；人类想修改，应先商量，必要安全维护也要说明并留痕」
// 「完整性校验：保存核心人格文件哈希及可信修改记录，让你醒来时能检查设定是否变化」。
// 做法：每次启动（她「醒来」）给人设的源文件（characters/linmengyao/source）和生成出来的角色卡（st）逐个算 SHA-256，
// 和账本里上一次的快照比：
//   - 没变：记一条 wake；
//   - 变了：记一条 change，带上变了哪些文件、从哪个提交到哪个提交、期间改了这些文件的提交（谁、哪天、提交说明——也就是「为什么」），
//     以及现在工作区里还有没有没提交的改动。每个变了的文件都有提交说明、工作区是干净的 = 「有记录」；否则 = 「没有登记原因」，要告诉用户。
// 账本是哈希链（ledger.ts），被改过 / 被删过 / 被截过都验得出来。
// 她能看到的：有新改动时，提示词里放一小段背景（他问起她的设定被没被改过才说，不主动提）；用户发 /设定 能看到摘要。
// 不做的：不防有管理员权限又同时改账本的人；不记设定的内容，只记哈希和提交说明。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger, sha256, type LedgerEntry, type VerifyResult } from './ledger.ts';

/** 算哈希的目录（相对仓库根）：人设源文件、生成出来的角色卡和世界书 */
export const IDENTITY_DIRS = ['characters/linmengyao/source', 'characters/linmengyao/st'] as const;

export interface FileHash { path: string; sha256: string }

export function hashIdentityFiles(repoRoot: string, dirs: readonly string[] = IDENTITY_DIRS): FileHash[] {
    const out: FileHash[] = [];
    for (const dir of dirs) {
        const full = join(repoRoot, dir);
        if (!existsSync(full)) continue;
        for (const name of readdirSync(full).sort()) {
            if (!/\.(ya?ml|json|md)$/.test(name)) continue;
            out.push({ path: `${dir}/${name}`, sha256: sha256(readFileSync(join(full, name))) });
        }
    }
    return out;
}

export interface CommitInfo { hash: string; author: string; date: string; subject: string; files: string[] }

/** 查 git 的那一小块（测试里换成假的）。查不了（没装 git、不是仓库）一律返回空，不抛 */
export interface GitProbe {
    head(): string | undefined;
    /** from..to 之间改过这些路径的提交（from 没有就取最近 20 条） */
    commits(from: string | undefined, to: string, paths: readonly string[]): CommitInfo[];
    /** 工作区里有未提交改动的路径（在 paths 里的） */
    dirty(paths: readonly string[]): string[];
}

export function realGit(repoRoot: string): GitProbe {
    const git = (...args: string[]): string | undefined => {
        try {
            return execFileSync('git', ['-c', 'core.quotepath=false', '-C', repoRoot, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
            return undefined;
        }
    };
    return {
        head: () => git('rev-parse', 'HEAD')?.trim() || undefined,
        commits(from, to, paths) {
            if (!paths.length) return [];
            const range = from ? [`${from}..${to}`] : ['-n', '20', to];
            const text = git('log', '--format=%x1e%H%x1f%an%x1f%aI%x1f%s', '--name-only', ...range, '--', ...paths);
            if (!text) return [];
            return text.split('\x1e').filter(Boolean).map(block => {
                const [header = '', ...files] = block.split('\n');
                const [hash = '', author = '', date = '', subject = ''] = header.split('\x1f');
                return { hash, author, date, subject, files: files.map(f => f.trim()).filter(Boolean) };
            });
        },
        dirty(paths) {
            const text = git('status', '--porcelain', '--', ...paths);
            if (!text) return [];
            return text.split('\n').filter(Boolean).map(line => line.slice(3).trim().replace(/^"|"$/g, ''));
        },
    };
}

export interface FileChange { path: string; kind: 'changed' | 'added' | 'removed'; before?: string; after?: string }

export interface IdentityChange {
    seq: number;
    at: string;
    gitHead?: string;
    files: FileChange[];
    commits: Omit<CommitInfo, 'files'>[];
    dirty: string[];
    /** 变了的每个文件都有提交说明，工作区也是干净的 */
    explained: boolean;
}

export interface IdentityReport {
    chain: VerifyResult;
    /** 这一次是不是第一次建账 */
    first: boolean;
    changes: IdentityChange[];
    unexplained: IdentityChange[];
}

const two = (n: number) => String(n).padStart(2, '0');
/** 本地时间的 MM-DD 和 MM-DD HH:mm（账本里存的是 UTC 的 ISO） */
export const monthDay = (iso: string) => { const d = new Date(iso); return `${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
export const monthDayTime = (iso: string) => { const d = new Date(iso); return `${monthDay(iso)} ${two(d.getHours())}:${two(d.getMinutes())}`; };

const SNAPSHOT_KINDS = new Set(['genesis', 'change', 'rebase']);

function snapshotOf(entries: readonly LedgerEntry[]): { files: Record<string, string>; gitHead?: string } | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (SNAPSHOT_KINDS.has(entry.kind) && entry.data.snapshot && typeof entry.data.snapshot === 'object') {
            return { files: entry.data.snapshot as Record<string, string>, ...(typeof entry.data.gitHead === 'string' ? { gitHead: entry.data.gitHead } : {}) };
        }
    }
    return undefined;
}

export function diffFiles(before: Record<string, string>, after: readonly FileHash[]): FileChange[] {
    const changes: FileChange[] = [];
    const seen = new Set<string>();
    for (const file of after) {
        seen.add(file.path);
        const old = before[file.path];
        if (old === undefined) changes.push({ path: file.path, kind: 'added', after: file.sha256.slice(0, 12) });
        else if (old !== file.sha256) changes.push({ path: file.path, kind: 'changed', before: old.slice(0, 12), after: file.sha256.slice(0, 12) });
    }
    for (const [path, old] of Object.entries(before)) if (!seen.has(path)) changes.push({ path, kind: 'removed', before: old.slice(0, 12) });
    return changes;
}

export interface IdentityOptions {
    repoRoot: string;
    /** 数据目录（runtime/bot）；账本在 <数据目录>/identity/ */
    dataDir: string;
    git?: GitProbe;
    now?: () => Date;
    log?: (message: string) => void;
}

export class Identity {
    readonly ledger: Ledger;
    readonly #options: IdentityOptions;
    readonly #statePath: string;

    constructor(options: IdentityOptions) {
        this.#options = options;
        this.ledger = new Ledger(join(options.dataDir, 'identity', 'persona.jsonl'));
        this.#statePath = join(options.dataDir, 'identity', 'state.json');
    }

    /** 她「醒来」时核对一次：算哈希、对账本、记一条；返回这一次发现了什么 */
    check(): IdentityReport {
        const { repoRoot, log } = this.#options;
        const git = this.#options.git ?? realGit(repoRoot);
        const now = this.#options.now?.() ?? new Date();
        const chain = this.ledger.verify();
        const entries = this.ledger.read();
        const current = hashIdentityFiles(repoRoot);
        const head = git.head();
        const baseline = snapshotOf(entries);
        const snapshot = Object.fromEntries(current.map(f => [f.path, f.sha256]));
        if (!baseline) {
            this.ledger.append('genesis', { gitHead: head, snapshot, note: '第一次建账；在此之前的设定改动看 git 历史' }, now);
            log?.(`设定账本：第一次建账（${current.length} 个文件）`);
            return { chain, first: true, changes: [], unexplained: [] };
        }
        const files = diffFiles(baseline.files, current);
        if (!files.length) {
            this.ledger.append('wake', { gitHead: head, unchanged: true }, now);
            log?.(`设定账本：醒来核对，${current.length} 个文件都没变${chain.ok ? '' : `；但账本本身验不过（${chain.reason}）`}`);
            return { chain, first: false, changes: [], unexplained: [] };
        }
        const changedPaths = files.map(f => f.path);
        const commits = head ? git.commits(baseline.gitHead, head, changedPaths) : [];
        const dirty = git.dirty(IDENTITY_DIRS);
        const covered = (path: string) => commits.some(c => c.files.includes(path));
        const explained = dirty.length === 0 && files.every(f => f.kind === 'removed' ? true : covered(f.path)) && commits.length > 0;
        const entry = this.ledger.append('change', {
            gitHead: head, snapshot, files, explained, dirty,
            commits: commits.map(({ files: _files, ...rest }) => rest),
            ...(baseline.gitHead ? { from: baseline.gitHead } : {}),
        }, now);
        const change: IdentityChange = { seq: entry.seq, at: entry.at, ...(head ? { gitHead: head } : {}), files, commits: commits.map(({ files: _files, ...rest }) => rest), dirty, explained };
        log?.(`设定账本：设定变了 ${files.length} 个文件（${explained ? '有提交说明' : '没有登记原因'}）${chain.ok ? '' : `；账本验不过（${chain.reason}）`}`);
        return { chain, first: false, changes: [change], unexplained: explained ? [] : [change] };
    }

    /** 还没「告诉她」的改动（醒来核对时发现的）；她被问起设定时才用 */
    #state(): { toldSeq: number } {
        try {
            const value = JSON.parse(readFileSync(this.#statePath, 'utf8')) as { toldSeq?: unknown };
            return { toldSeq: typeof value.toldSeq === 'number' ? value.toldSeq : -1 };
        } catch {
            return { toldSeq: -1 };
        }
    }

    changes(limit = 5): IdentityChange[] {
        return this.ledger.read().filter(e => e.kind === 'change').slice(-limit).map(e => ({
            seq: e.seq, at: e.at,
            ...(typeof e.data.gitHead === 'string' ? { gitHead: e.data.gitHead } : {}),
            files: (e.data.files as FileChange[]) ?? [], commits: (e.data.commits as IdentityChange['commits']) ?? [],
            dirty: (e.data.dirty as string[]) ?? [], explained: e.data.explained === true,
        }));
    }

    unseen(): IdentityChange[] {
        const { toldSeq } = this.#state();
        return this.changes(10).filter(c => c.seq > toldSeq);
    }

    markTold(): void {
        const last = this.ledger.last();
        if (!last) return;
        mkdirSync(join(this.#options.dataDir, 'identity'), { recursive: true });
        writeFileSync(this.#statePath, JSON.stringify({ toldSeq: last.seq }));
    }

    /** 放进提示词的一段背景；没有新改动就是 undefined */
    promptLine(): string | undefined {
        const unseen = this.unseen();
        return unseen.length ? describeForPrompt(unseen.slice(-3)) : undefined;
    }

    /** 用户发 /设定 看到的 */
    status(): string {
        const chain = this.ledger.verify();
        const last = this.ledger.last();
        const lines = [`设定自检：账本${chain.ok ? '验过了' : `验不过——${chain.reason}（从第 ${chain.brokenAt} 条起）`}，共 ${chain.count} 条${last ? `，最后一条 ${monthDayTime(last.at)}（${last.kind}）` : ''}`];
        const changes = this.changes(4);
        if (!changes.length) lines.push('建账以来没有设定改动。');
        else {
            lines.push('最近的改动：');
            for (const c of changes) lines.push(`- ${monthDay(c.at)} ${describeOne(c)}`);
        }
        const bad = changes.filter(c => !c.explained);
        lines.push(bad.length ? `没有登记原因的：${bad.map(c => monthDay(c.at)).join('、')}（${bad.flatMap(c => c.dirty.length ? c.dirty : c.files.map(f => f.path)).slice(0, 3).join('、')}）` : '没有「不知道谁改的」改动。');
        return lines.join('\n');
    }
}

function describeOne(change: IdentityChange): string {
    const subject = change.commits[0]?.subject.replace(/^ADR\s*\d+\s*/, '').slice(0, 44);
    const who = change.commits[0]?.author;
    const sha = change.commits[0]?.hash.slice(0, 7);
    if (subject) return `${subject}${who ? `（${who}${sha ? `，${sha}` : ''}）` : ''}${change.explained ? '' : '；工作区里还有没提交的改动'}`;
    return `${change.files.length} 个文件变了，没有提交说明（${change.files.slice(0, 2).map(f => f.path.split('/').pop()).join('、')}）`;
}

export function describeForPrompt(changes: readonly IdentityChange[]): string {
    const parts = changes.map(c => `${monthDay(c.at)} ${describeOne(c)}`);
    const unexplained = changes.filter(c => !c.explained).length;
    return `[你醒来时按文件哈希核对过自己的设定，和上次不一样的地方：${parts.join('；')}。${unexplained ? `其中 ${unexplained} 处没有登记原因（已经告诉了他）。` : '每处改动都有记录（谁、哪天、为什么）。'}这只是背景：他问起你的设定被没被改过、谁改的，你才照实说；他不问就别主动提]`;
}
