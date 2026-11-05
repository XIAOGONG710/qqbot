// Durable deletion intent. No message/model bodies are stored here. A live PID
// lock only excludes current writers; this journal also survives their exit.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ForgetPlan } from './privacy-forget.ts';
import { writeJsonAtomic } from './json-file.ts';

export const FORGET_JOBS_DIRECTORY = 'maintenance/forget-jobs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const unique = (v: string[]) => new Set(v).size === v.length;
const safeError = () => new Error('遗忘任务读取或校验失败；原件未修改，拒绝处理或启动');
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) => object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
// Compare the data-root identity like the platform lease. Keep the originally
// persisted spelling untouched: it remains part of the immutable plan digest.
const rootIdentity = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export interface ForgetFile { path: string; size: number; hash: string }
export interface ForgetRemote {
    kind: 'document' | 'model' | 'bank'; bank: string; id?: string;
    state: 'pending' | 'dispatching' | 'uncertain' | 'done';
}
export interface ForgetJob {
    version: 1; id: string; root: string; trash: string; plan: ForgetPlan;
    files: ForgetFile[]; remote: ForgetRemote[]; remoteEnabled: boolean; remoteScope?: string;
    moved: string[]; complete: boolean; planHash: string;
}
const remoteIdentity = (r: ForgetRemote) => ({ kind: r.kind, bank: r.bank, ...(r.id === undefined ? {} : { id: r.id }) });
const immutable = (j: ForgetJob) => ({ version: j.version, id: j.id, root: j.root, trash: j.trash, plan: j.plan,
    files: j.files, remote: j.remote.map(remoteIdentity), remoteEnabled: j.remoteEnabled,
    ...(j.remoteScope === undefined ? {} : { remoteScope: j.remoteScope }) });

function pathParts(path: string): string[] {
    if (!path || isAbsolute(path) || /[:\0]/.test(path)) throw safeError();
    const parts = path.split(/[\\/]/);
    if (parts.some(p => !p || p === '.' || p === '..')) throw safeError();
    return parts;
}
function ownedPath(path: string, qq: number): boolean {
    let parts: string[]; try { parts = pathParts(path); } catch { return false; }
    if (parts.length === 1) return parts[0] === 'last-prompt.json';
    if (!['chats', 'memory', 'promises', 'proactive', 'context', 'jokes', 'idioms'].includes(parts[0]!)) return false;
    const name = parts.at(-1)!;
    return name === `${qq}.json` || name === `${qq}.jsonl` || name.startsWith(`${qq}-`)
        || parts[0] === 'chats' && new RegExp(`^${qq}\\.recalled\\.json(?:\\.tmp-\\d+-\\d+|\\.corrupt-\\d+)?$`).test(name);
}
/** Validate every existing ancestor, including the data root and trash root. */
export function assertForgetPath(path: string): void {
    for (let part = resolve(path);; part = dirname(part)) {
        // existsSync follows links and reports a dangling junction as absent.
        // lstat must inspect the directory entry itself before accepting ENOENT.
        try { if (lstatSync(part).isSymbolicLink()) throw safeError(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw safeError(); }
        if (part === dirname(part)) break;
    }
}
export function forgetFilePath(root: string, path: string): string {
    const target = join(resolve(root), ...pathParts(path));
    const rel = relative(resolve(root), target);
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw safeError();
    assertForgetPath(target); return target;
}
export function fingerprintForgetFile(path: string): { size: number; hash: string } {
    assertForgetPath(path);
    if (!lstatSync(path).isFile()) throw safeError();
    const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    try {
        for (;;) { const bytes = readSync(fd, buffer); if (!bytes) break; hash.update(buffer.subarray(0, bytes)); size += bytes; }
        return { size, hash: hash.digest('hex') };
    } finally { closeSync(fd); }
}
export function sameForgetFile(path: string, file: ForgetFile): boolean {
    const got = fingerprintForgetFile(path); return got.size === file.size && got.hash === file.hash;
}
export function forgetRemoteTargets(plan: ForgetPlan): ForgetRemote[] {
    const out: ForgetRemote[] = [], seen = new Set<string>();
    const add = (r: ForgetRemote) => { const key = canonical(remoteIdentity(r)); if (!seen.has(key)) { seen.add(key); out.push(r); } };
    for (const t of [{ bankId: plan.hindsight.commonBank, documents: plan.hindsight.documents, mentalModels: plan.hindsight.mentalModels }, ...(plan.hindsight.commonTargets ?? [])]) {
        for (const id of t.documents) add({ kind: 'document', bank: t.bankId, id, state: 'pending' });
        for (const id of t.mentalModels) add({ kind: 'model', bank: t.bankId, id, state: 'pending' });
    }
    for (const bank of plan.hindsight.banks) add({ kind: 'bank', bank, state: 'pending' });
    return out;
}
function validPlan(v: unknown): v is ForgetPlan {
    if (!object(v) || !Number.isSafeInteger(v.qq) || (v.qq as number) <= 0 || !strings(v.move) || !unique(v.move)
        || !v.move.every(p => ownedPath(p, v.qq as number)) || !Array.isArray(v.leave)
        || !v.leave.every(x => object(x) && typeof x.path === 'string' && typeof x.note === 'string'
            && (x.references === undefined || Number.isSafeInteger(x.references) && (x.references as number) >= 0))
        || !strings(v.limitations) || !object(v.hindsight)) return false;
    const h = v.hindsight;
    const names = (x: unknown): x is string[] => strings(x) && x.every(s => s.length > 0 && !/[\0\r\n]/.test(s));
    return typeof h.commonBank === 'string' && /^[A-Za-z0-9-]+$/.test(h.commonBank)
        && names(h.banks) && names(h.documents) && names(h.mentalModels)
        && (h.commonTargets === undefined || Array.isArray(h.commonTargets) && h.commonTargets.every(t => object(t)
            && typeof t.bankId === 'string' && /^[A-Za-z0-9-]+$/.test(t.bankId) && names(t.documents) && names(t.mentalModels)));
}
function validJob(v: unknown, root: string, id: string): v is ForgetJob {
    if (!object(v) || !validPlan(v.plan)) return false;
    const plan = v.plan;
    if (!object(v) || v.version !== 1 || v.id !== id || !UUID.test(id) || typeof v.root !== 'string'
        || !isAbsolute(v.root) || rootIdentity(v.root) !== rootIdentity(root)
        || typeof v.trash !== 'string' || !isAbsolute(v.trash) || resolve(v.trash) !== v.trash || !validPlan(v.plan)
        || !Array.isArray(v.files) || v.files.length !== v.plan.move.length
        || !v.files.every((f, n) => object(f) && f.path === plan.move[n] && Number.isSafeInteger(f.size) && (f.size as number) >= 0 && typeof f.hash === 'string' && HASH.test(f.hash))
        || !Array.isArray(v.remote) || typeof v.remoteEnabled !== 'boolean'
        || v.remoteScope !== undefined && (typeof v.remoteScope !== 'string' || !HASH.test(v.remoteScope))
        || !strings(v.moved) || !unique(v.moved) || !v.moved.every(p => plan.move.includes(p))
        || typeof v.complete !== 'boolean' || typeof v.planHash !== 'string' || !HASH.test(v.planHash)) return false;
    const expected = v.remoteEnabled ? forgetRemoteTargets(v.plan) : [];
    if (expected.length !== v.remote.length || !v.remote.every((r, n) => object(r) && ['pending', 'dispatching', 'uncertain', 'done'].includes(r.state as string)
        && canonical(remoteIdentity(r as unknown as ForgetRemote)) === canonical(remoteIdentity(expected[n]!)))) return false;
    const j = v as unknown as ForgetJob;
    return (!j.complete || j.moved.length === j.files.length && j.remote.every(r => r.state === 'done')) && digest(immutable(j)) === j.planHash;
}
/** Pure schema/digest validator for auditing final or actual atomic tmp metadata. */
export { validJob as isForgetJob };
function jobsDirectory(root: string): string { const dir = join(resolve(root), FORGET_JOBS_DIRECTORY); assertForgetPath(dir); return dir; }
export function loadForgetJob(root: string, id: string): ForgetJob {
    if (!UUID.test(id)) throw safeError();
    try {
        const path = join(jobsDirectory(root), `${id}.json`); assertForgetPath(path);
        const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!validJob(value, root, id)) throw safeError();
        assertForgetPath(value.trash); return value;
    } catch { throw safeError(); }
}
/** Read-only boot barrier; malformed/unknown journal files cannot silently clear it. */
export function unfinishedForgetJobs(root: string): string[] {
    const dir = jobsDirectory(root);
    let names: string[];
    try { names = readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw safeError(); }
    const ids: string[] = [];
    for (const name of names) {
        // Atomic-write leftovers are not authoritative, but a missing final file
        // with a leftover is an unconfirmed intent and must not open the bank.
        const tmp = /^([0-9a-f-]+)\.json\.tmp-\d+-\d+$/.exec(name);
        if (tmp) { if (!UUID.test(tmp[1]!) || !existsSync(join(dir, `${tmp[1]}.json`))) throw safeError(); continue; }
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) throw safeError();
        const id = name.slice(0, -5); if (!loadForgetJob(root, id).complete) ids.push(id);
    }
    return ids.sort();
}
export function saveForgetJob(root: string, job: ForgetJob): void {
    if (!validJob(job, root, job.id)) throw safeError();
    const dir = jobsDirectory(root); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${job.id}.json`); assertForgetPath(path);
    try { writeJsonAtomic(path, job); }
    catch {
        // A rename may have published successfully before its wrapper failed.
        // Confirm exact intended bytes logically; never replay a successful RPC.
        try { if (canonical(loadForgetJob(root, job.id)) === canonical(job)) return; } catch { /* fixed error below */ }
        throw new Error('遗忘任务持久写入未确认；停止处理并保留恢复屏障');
    }
}
export function createForgetJob(root: string, plan: ForgetPlan, trash: string, remoteEnabled: boolean, remoteScope?: string): ForgetJob {
    const job: ForgetJob = { version: 1, id: randomUUID(), root: resolve(root), trash: resolve(trash), plan,
        files: plan.move.map(path => ({ path, ...fingerprintForgetFile(forgetFilePath(root, path)) })),
        remote: remoteEnabled ? forgetRemoteTargets(plan) : [], remoteEnabled,
        ...(remoteScope === undefined ? {} : { remoteScope }), moved: [], complete: false, planHash: '' };
    job.planHash = digest(immutable(job)); saveForgetJob(root, job); return job;
}
