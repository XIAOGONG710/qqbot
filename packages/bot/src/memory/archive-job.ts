import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertForgetPath, fingerprintForgetFile } from './forget-job.ts';
import { writeJsonAtomic } from './json-file.ts';
import type { ArchiveResult } from './archive.ts';

export const ARCHIVE_JOBS_DIRECTORY = 'maintenance/archive-jobs';
interface Fingerprint { size: number; hash: string }
export interface ArchiveStep { kind: 'copy' | 'move' | 'replace'; source: string; target: string; before: Fingerprint; after: Fingerprint; content?: string }
export interface ArchiveJob { version: 1; id: string; root: string; prefix: string; result: ArchiveResult; steps: ArchiveStep[]; configTargets: string[]; done: number[]; complete: boolean; planHash: string }
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !/[\0\r\n]/.test(v);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const archiveTextFingerprint = (content: string): Fingerprint => ({ size: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') });
const fingerprint = (v: unknown): v is Fingerprint => object(v) && Number.isSafeInteger(v.size) && Number(v.size) >= 0 && typeof v.hash === 'string' && HASH.test(v.hash);
const same = (path: string, expected: Fingerprint) => isDeepStrictEqual(fingerprintForgetFile(path), expected);
const identity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const fail = () => new Error('归档任务读取或恢复未确认；保留原计划与文件，拒绝继续或启动');
const immutable = (job: ArchiveJob) => ({ version: job.version, id: job.id, root: job.root, prefix: job.prefix, result: job.result, steps: job.steps, configTargets: job.configTargets });
function within(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}
function valid(value: unknown, root: string, id: string): value is ArchiveJob {
    if (!object(value) || value.version !== 1 || value.id !== id || !UUID.test(id) || !text(value.root) || identity(value.root) !== identity(root) || typeof value.prefix !== 'string' || !/^[A-Za-z0-9-]+$/.test(value.prefix)
        || !Array.isArray(value.configTargets) || !value.configTargets.every(p => text(p) && isAbsolute(p)) || new Set(value.configTargets.map(identity)).size !== value.configTargets.length
        || !object(value.result) || typeof value.result.stamp !== 'string' || !/^\d{5,8}-\d{4}$/.test(value.result.stamp)
        || !Array.isArray(value.result.moves) || !Array.isArray(value.result.since) || !Array.isArray(value.result.prefix) || !Array.isArray(value.result.skipped)
        || !Array.isArray(value.steps) || !Array.isArray(value.done) || !value.done.every((n, index) => n === index) || value.done.length > value.steps.length
        || typeof value.complete !== 'boolean' || value.complete && value.done.length !== value.steps.length || typeof value.planHash !== 'string' || !HASH.test(value.planHash)) return false;
    const configs = value.configTargets as string[], dataRoot = value.root;
    if (!value.steps.every(step => {
        if (!object(step) || !text(step.source) || !text(step.target) || !isAbsolute(step.source) || !isAbsolute(step.target) || !fingerprint(step.before) || !fingerprint(step.after)) return false;
        if (step.kind === 'replace') return step.source === step.target && typeof step.content === 'string' && isDeepStrictEqual(archiveTextFingerprint(step.content), step.after)
            && (identity(step.target) === identity(join(dataRoot, 'tiers.json')) || configs.some(path => identity(path) === identity(step.target as string)));
        if (step.kind === 'copy') return identity(step.source) === identity(join(dataRoot, 'tiers.json')) && within(dataRoot, step.target)
            && /^tiers\.before-\d{5,8}-\d{4}(?:-\d+)?\.json$/.test(relative(dataRoot, step.target)) && isDeepStrictEqual(step.before, step.after) && step.content === undefined;
        if (step.kind !== 'move' || !within(dataRoot, step.source) || !within(dataRoot, step.target) || !isDeepStrictEqual(step.before, step.after) || step.content !== undefined) return false;
        const from = relative(dataRoot, step.source).split(/[\\/]/), to = relative(dataRoot, step.target).split(/[\\/]/);
        return from.length === 2 && ['chats', 'memory', 'proactive'].includes(from[0]!) && to.length === 3 && from[0] === to[0]
            && (from[0] === 'chats' ? to[1] === 'archive' : /^archive-\d{5,8}-\d{4}$/.test(to[1]!));
    })) return false;
    const targets = value.steps.map(step => identity((step as ArchiveStep).target));
    if (new Set(targets).size !== targets.length || digest(immutable(value as unknown as ArchiveJob)) !== value.planHash) return false;
    const result = value.result as Record<string, unknown> & { moves: unknown[]; since: unknown[]; skipped: unknown[]; prefix: unknown[] }, steps = value.steps as ArchiveStep[];
    if (!result.moves.every(move => object(move) && text(move.from) && text(move.to) && isAbsolute(move.from) && isAbsolute(move.to))
        || !isDeepStrictEqual((result.moves as { from: string; to: string }[]).map(move => ({ from: identity(move.from), to: identity(move.to) })), steps.filter(step => step.kind === 'move').map(step => ({ from: identity(step.source), to: identity(step.target) })))
        || !result.since.every(entry => object(entry) && typeof entry.qq === 'string' && /^[1-9]\d*$/.test(entry.qq) && Number.isSafeInteger(Number(entry.qq)) && text(entry.tier))
        || !result.skipped.every(entry => object(entry) && text(entry.file) && isAbsolute(entry.file) && text(entry.reason))
        || !result.prefix.every(entry => object(entry) && text(entry.file) && isAbsolute(entry.file) && entry.to === value.prefix
            && (entry.from === undefined || typeof entry.from === 'string') && configs.some(path => identity(path) === identity(entry.file as string)))
        || result.prefix.length !== configs.length) return false;
    const copies = steps.filter(step => step.kind === 'copy');
    if (copies.length > 1 || (result.tiersBackup === undefined ? copies.length !== 0 : !text(result.tiersBackup) || copies[0]?.target !== result.tiersBackup)) return false;
    if (steps.filter(step => step.kind === 'replace' && configs.some(path => identity(path) === identity(step.target))).length !== configs.length) return false;
    return true;
}
export { valid as isArchiveJob };
function directory(root: string): string { const dir = join(resolve(root), ARCHIVE_JOBS_DIRECTORY); assertForgetPath(dir); return dir; }
export function loadArchiveJob(root: string, id: string): ArchiveJob {
    try {
        if (!UUID.test(id)) throw fail();
        const path = join(directory(root), `${id}.json`); assertForgetPath(path);
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!valid(value, root, id)) throw fail(); return value;
    } catch { throw fail(); }
}
export function unfinishedArchiveJobs(root: string): string[] {
    const dir = directory(root); let names: string[];
    try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw fail(); }
    const pending: string[] = [];
    for (const name of names) {
        const tmp = /^([a-f0-9-]+)\.json\.tmp-\d+-\d+$/.exec(name);
        if (tmp) { if (!UUID.test(tmp[1]!) || !existsSync(join(dir, `${tmp[1]}.json`))) throw fail(); continue; }
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) throw fail();
        const id = name.slice(0, -5); if (!loadArchiveJob(root, id).complete) pending.push(id);
    }
    return pending.sort();
}
export function saveArchiveJob(root: string, job: ArchiveJob): void {
    if (!valid(job, root, job.id)) throw fail();
    const dir = directory(root); mkdirSync(dir, { recursive: true }); const path = join(dir, `${job.id}.json`); assertForgetPath(path);
    try { writeJsonAtomic(path, job); }
    catch { try { if (isDeepStrictEqual(loadArchiveJob(root, job.id), job)) return; } catch { /* Preserve the original failed publication. */ } throw fail(); }
}
export function createArchiveJob(root: string, result: ArchiveResult, steps: ArchiveStep[], configTargets: string[], prefix: string): ArchiveJob {
    const normalized = { ...structuredClone(result), moves: result.moves.map(move => ({ from: resolve(move.from), to: resolve(move.to) })),
        prefix: result.prefix.map(entry => ({ ...entry, file: resolve(entry.file) })), skipped: result.skipped.map(entry => ({ ...entry, file: resolve(entry.file) })),
        ...(result.tiersBackup ? { tiersBackup: resolve(result.tiersBackup) } : {}) };
    const job: ArchiveJob = { version: 1, id: randomUUID(), root: resolve(root), prefix, result: normalized, steps: structuredClone(steps), configTargets: configTargets.map(resolvePath => resolve(resolvePath)), done: [], complete: false, planHash: '' };
    job.planHash = digest(immutable(job)); saveArchiveJob(root, job); return job;
}
/** Replay only the immutable original delta. Publication/rename followed by failure is confirmed by exact file fingerprint. */
export function resumeArchiveJob(root: string, id: string): ArchiveResult {
    const job = loadArchiveJob(root, id);
    if (job.complete) return { ...job.result, jobId: job.id, complete: true };
    for (let index = 0; index < job.steps.length; index++) {
        const step = job.steps[index]!; assertForgetPath(step.source); assertForgetPath(step.target);
        if (index < job.done.length) {
            // Earlier replacement may legitimately have changed a copy's source; its destination is the receipt.
            if (!existsSync(step.target) || !same(step.target, step.after)) throw fail();
            continue;
        }
        try {
            if (step.kind === 'replace') {
                if (!existsSync(step.target)) throw fail();
                if (!same(step.target, step.after)) {
                    if (!same(step.source, step.before)) throw fail();
                    const temp = `${step.target}.archive-${job.id}-${index}.tmp`; assertForgetPath(temp);
                    if (existsSync(temp)) { if (!same(temp, step.after)) throw fail(); }
                    else writeFileSync(temp, step.content!, { flag: 'wx' });
                    renameSync(temp, step.target);
                }
            } else if (step.kind === 'copy') {
                if (existsSync(step.target)) { if (!same(step.target, step.after)) throw fail(); }
                else { if (!same(step.source, step.before)) throw fail(); mkdirSync(dirname(step.target), { recursive: true }); copyFileSync(step.source, step.target, constants.COPYFILE_EXCL); }
            } else {
                if (existsSync(step.source)) {
                    if (existsSync(step.target) || !same(step.source, step.before)) throw fail();
                    mkdirSync(dirname(step.target), { recursive: true }); renameSync(step.source, step.target);
                }
            }
        } catch {
            if (!existsSync(step.target) || !same(step.target, step.after) || step.kind === 'move' && existsSync(step.source)) throw fail();
        }
        if (!existsSync(step.target) || !same(step.target, step.after) || step.kind === 'move' && existsSync(step.source)) throw fail();
        job.done.push(index); saveArchiveJob(root, job);
    }
    if (!job.complete) { job.complete = true; saveArchiveJob(root, job); }
    return { ...job.result, jobId: job.id, complete: true };
}
