import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { exportContact, forgetContact, type ForgetApi } from '../src/memory/privacy-forget.ts';
import { loadForgetJob, unfinishedForgetJobs } from '../src/memory/forget-job.ts';
import { fileOps } from '../src/memory/json-file.ts';

const owner = createHash('sha256').update('qqbot:10001-boyfriend').digest('hex').slice(0, 16);
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-forget-recovery-')), data = join(root, 'data');
    mkdirSync(join(data, 'memory'), { recursive: true }); mkdirSync(join(data, 'chats'));
    writeFileSync(join(data, 'chats', '10001.jsonl'), 'SYNTHETIC_PRIVATE_FACT\n');
    writeFileSync(join(data, 'memory', '10001-boyfriend.json'), JSON.stringify({ bankId: `old-${owner}`, common: { 'ep-1': 1 }, personModel: 'v1' }));
    return { root, data, trashDir: join(root, 'trash') };
}
const fake = (calls: string[]): ForgetApi => ({
    async deleteBank(bank) { calls.push(`bank:${bank}`); },
    async deleteDocument(bank, id) { calls.push(`document:${bank}:${id}`); },
    async deleteMentalModel(bank, id) { calls.push(`model:${bank}:${id}`); },
});
const options = (f: ReturnType<typeof fixture>, api: ForgetApi) => ({ apply: true, trashDir: f.trashDir, commonBank: 'new-common', api });

test('apply等待远端期间独立进程不能取得bot锁，锁覆盖本地移动至返回', async () => {
    const f = fixture();
    try {
        const lockModule = pathToFileURL(join(import.meta.dirname, '../src/platform/lock.ts')).href;
        let attempted = false;
        const api = fake([]);
        api.deleteDocument = async () => {
            if (attempted) return; attempted = true;
            const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireLock} from ${JSON.stringify(lockModule)}; try {const release=acquireLock(process.argv[1]); release();process.exitCode=7;}catch{process.exitCode=0;}`, join(f.data, 'bot.lock')], { stdio: 'ignore' });
            const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
            assert.equal(code, 0, '真实第二进程必须被forget持有的锁拒绝');
        };
        const result = await forgetContact(f.data, 10001, options(f, api));
        assert.equal(result.failures.length, 0); assert.equal(attempted, true);
        assert.equal(existsSync(join(f.data, 'bot.lock')), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('503结果不明仍持久保留历史目标，显式resume不误报空成功或盲目重发', async () => {
    const f = fixture();
    try {
        const unavailable = async () => { const e = new Error('SYNTHETIC_PRIVATE_RESPONSE'); Object.assign(e, { status: 503 }); throw e; };
        const first = await forgetContact(f.data, 10001, options(f, { deleteBank: unavailable, deleteDocument: unavailable, deleteMentalModel: unavailable }));
        assert.equal(first.failures.length, 5);
        const jobs = join(f.data, 'maintenance', 'forget-jobs');
        assert.ok(existsSync(jobs), '移动前必须持久保存可恢复任务');
        const id = readdirSync(jobs).find(name => name.endsWith('.json'))!.slice(0, -5);
        const calls: string[] = [];
        const resumed = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: id } as Parameters<typeof forgetContact>[2]);
        assert.equal(resumed.failures.length, 5); assert.equal(calls.length, 0);
        const job = loadForgetJob(f.data, id);
        assert.ok(job.remote.some(item => item.bank === `old-${owner}`));
        assert.ok(job.remote.some(item => item.bank === 'old-common' && item.id === `${owner}:ep-1`));
        assert.deepEqual(unfinishedForgetJobs(f.data), [id]);
        assert.equal(resumed.complete, false);
        assert.equal(resumed.trash, first.trash);
        assert.doesNotMatch(readFileSync(join(jobs, `${id}.json`), 'utf8'), /SYNTHETIC_PRIVATE/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('真实独立进程在rename后checkpoint前退出，按原任务恢复本地事实并继续历史目标', async () => {
    const f = fixture();
    try {
        const module = pathToFileURL(join(import.meta.dirname, '../src/memory/privacy-forget.ts')).href;
        const source = join(f.data, 'chats', '10001.jsonl');
        const script = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{const result=rename(from,to);if(String(from)===${JSON.stringify(source)})process.exit(23);return result;};syncBuiltinESMExports();const {forgetContact}=await import(${JSON.stringify(module)});await forgetContact(${JSON.stringify(f.data)},10001,{apply:true,trashDir:${JSON.stringify(f.trashDir)},commonBank:'new-common',api:{async deleteBank(){},async deleteDocument(){},async deleteMentalModel(){}}});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; child.stderr.setEncoding('utf8').on('data', text => stderr += text);
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 23, stderr); assert.equal(existsSync(source), false);
        const [id] = unfinishedForgetJobs(f.data); assert.ok(id);
        const before = loadForgetJob(f.data, id); assert.equal(before.moved.length, 0);
        assert.equal(before.remote.every(item => item.state === 'pending'), true);
        const calls: string[] = [];
        const result = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), commonBank: 'wrong-new-target-common', resume: id });
        assert.equal(result.complete, true); assert.equal(result.trash, before.trash); assert.equal(calls.length, 5);
        assert.equal(calls.some(call => call.includes('wrong-new-target')), false);
        assert.ok(calls.includes(`document:old-common:${owner}:ep-1`));
        assert.deepEqual(unfinishedForgetJobs(f.data), []);
        assert.equal(readFileSync(join(before.trash, 'chats', '10001.jsonl'), 'utf8'), 'SYNTHETIC_PRIVATE_FACT\n');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('远端派发中退出或unknown ACK后恢复不重发；缺省新任务也不能绕过原屏障', async () => {
    const f = fixture();
    try {
        let attempts = 0; const api = fake([]);
        api.deleteDocument = async () => { attempts++; throw undefined; };
        const result = await forgetContact(f.data, 10001, options(f, api));
        assert.equal(result.complete, false); assert.equal(attempts, 2);
        const id = result.jobId!;
        const calls: string[] = [];
        const retry = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: id });
        assert.equal(calls.length, 0); assert.equal(retry.failures.length, 2);
        await assert.rejects(forgetContact(f.data, 10001, options(f, fake(calls))), /未完成.*resume/);
        // A crash can leave dispatching instead of the explicit uncertain write.
        const jobPath = join(f.data, 'maintenance', 'forget-jobs', `${id}.json`);
        const stored = JSON.parse(readFileSync(jobPath, 'utf8')); stored.remote[0].state = 'dispatching';
        writeFileSync(jobPath, JSON.stringify(stored));
        const restarted = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: id });
        assert.equal(restarted.complete, false); assert.equal(calls.length, 0); assert.deepEqual(unfinishedForgetJobs(f.data), [id]);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('job发布前失败不移动原件，发布后抛错按readback确认且不重放已确认远端', async () => {
    const f = fixture(), original = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = ((from, to) => { if (String(to).includes('forget-jobs')) throw Object.assign(new Error('SYNTHETIC_PRIVATE_IO'), { code: 'EIO' }); return original(from, to); }) as typeof original;
        const calls: string[] = [];
        await assert.rejects(forgetContact(f.data, 10001, options(f, fake(calls))), error => error instanceof Error && !error.message.includes('SYNTHETIC_PRIVATE'));
        assert.ok(existsSync(join(f.data, 'chats', '10001.jsonl'))); assert.ok(existsSync(join(f.data, 'memory', '10001-boyfriend.json'))); assert.equal(calls.length, 0);
        let published = false;
        fileOps.renameSync = ((from, to) => { const result = original(from, to); if (!published && String(to).includes('forget-jobs')) { published = true; throw Object.assign(new Error('SYNTHETIC_PRIVATE_AFTER_RENAME'), { code: 'EIO' }); } return result; }) as typeof original;
        const result = await forgetContact(f.data, 10001, options(f, fake(calls)));
        assert.equal(result.complete, true); assert.equal(calls.length, 5);
        await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: result.jobId });
        assert.equal(calls.length, 5); assert.deepEqual(unfinishedForgetJobs(f.data), []);
    } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; rmSync(f.root, { recursive: true, force: true }); }
});

test('篡改计划/跨目录路径/损坏JSON失败关闭且不泄漏原文，export和dryrun不能吞坏任务', async () => {
    const f = fixture();
    try {
        const fail = async () => { throw new Error('SYNTHETIC_PRIVATE_FAILURE'); };
        const first = await forgetContact(f.data, 10001, options(f, { deleteBank: fail, deleteDocument: fail, deleteMentalModel: fail }));
        const path = join(f.data, 'maintenance', 'forget-jobs', `${first.jobId}.json`), original = readFileSync(path, 'utf8');
        const job = JSON.parse(original); job.plan.move[0] = '../../outside.json'; job.files[0].path = '../../outside.json';
        writeFileSync(path, JSON.stringify(job));
        assert.throws(() => unfinishedForgetJobs(f.data), /校验失败/);
        const calls: string[] = [];
        await assert.rejects(forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: first.jobId }), /校验失败/); assert.equal(calls.length, 0);
        const edited = JSON.parse(original); edited.plan.hindsight.banks.push('not-authorized-bank'); writeFileSync(path, JSON.stringify(edited));
        assert.throws(() => loadForgetJob(f.data, first.jobId!), /校验失败/);
        const broken = '{"SYNTHETIC_PRIVATE_BROKEN_JSON"'; writeFileSync(path, broken);
        assert.throws(() => exportContact(f.data, 10001, join(f.root, 'out')), e => e instanceof Error && !e.message.includes('SYNTHETIC_PRIVATE'));
        await assert.rejects(forgetContact(f.data, 10001, { ...options(f, fake(calls)), apply: false }), e => e instanceof Error && !e.message.includes('SYNTHETIC_PRIVATE'));
        assert.equal(readFileSync(path, 'utf8'), broken); assert.equal(existsSync(join(f.data, 'bot.lock')), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('远端ACK之后checkpoint发布前/后故障不重放已确认删除，不把未知结果标complete', async () => {
    for (const afterRename of [false, true]) {
        const f = fixture(), original = fileOps.renameSync, delays = fileOps.writeDelaysMs;
        try {
            fileOps.writeDelaysMs = [0]; let injected = false;
            fileOps.renameSync = ((from, to) => {
                if (!injected && String(to).includes('forget-jobs')) {
                    const next = JSON.parse(readFileSync(from, 'utf8'));
                    if (next.remote[0]?.state === 'done') {
                        injected = true; if (afterRename) original(from, to);
                        throw Object.assign(new Error('SYNTHETIC_PRIVATE_ACK_CHECKPOINT'), { code: 'EIO' });
                    }
                }
                return original(from, to);
            }) as typeof original;
            const calls: string[] = [];
            let result: Awaited<ReturnType<typeof forgetContact>> | undefined;
            if (afterRename) result = await forgetContact(f.data, 10001, options(f, fake(calls)));
            else await assert.rejects(forgetContact(f.data, 10001, options(f, fake(calls))), /持久写入未确认/);
            fileOps.renameSync = original;
            const jobName = readdirSync(join(f.data, 'maintenance', 'forget-jobs')).find(name => name.endsWith('.json'))!;
            const retry = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: jobName.slice(0, -5) });
            assert.equal(calls.filter(call => call === `document:new-common:${owner}:ep-1`).length, 1);
            assert.equal(retry.complete, afterRename);
            assert.equal(afterRename ? result?.complete : retry.failures.length > 0, true);
        } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; rmSync(f.root, { recursive: true, force: true }); }
    }
});

test('真实CLI本地清理发布完成job/report及安全审计，退出释放目录锁', async () => {
    const f = fixture();
    try {
        const cli = join(import.meta.dirname, '../src/memory/privacy-forget.ts');
        const child = spawn(process.execPath, [cli, 'forget', '--data', f.data, '--qq', '10001', '--trash', f.trashDir, '--apply'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '', stderr = ''; child.stdout.setEncoding('utf8').on('data', text => output += text); child.stderr.setEncoding('utf8').on('data', text => stderr += text);
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 0, stderr); assert.doesNotMatch(output + stderr, /SYNTHETIC_PRIVATE_FACT/);
        assert.deepEqual(unfinishedForgetJobs(f.data), []); assert.equal(existsSync(join(f.data, 'bot.lock')), false);
        const ledger = readFileSync(join(f.data, 'identity', 'memory.jsonl'), 'utf8');
        assert.match(ledger, /"kind":"forget"/); assert.doesNotMatch(ledger, /SYNTHETIC_PRIVATE_FACT/);
        const [name] = readdirSync(join(f.data, 'maintenance', 'forget-jobs'));
        const job = loadForgetJob(f.data, name!.slice(0, -5));
        assert.equal(job.complete, true); assert.equal(JSON.parse(readFileSync(join(job.trash, 'forget-report.json'), 'utf8')).complete, true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('计划创建后原文件变化暂停移动和远端删除，恢复不扩大QQ/endpoint归属', async () => {
    const f = fixture(), original = fileOps.renameSync;
    try {
        let changed = false;
        fileOps.renameSync = ((from, to) => {
            const result = original(from, to);
            if (!changed && String(to).includes('forget-jobs')) { changed = true; writeFileSync(join(f.data, 'chats', '10001.jsonl'), 'SYNTHETIC_NEW_FACT\n'); }
            return result;
        }) as typeof original;
        const calls: string[] = [], scope = 'a'.repeat(64);
        const first = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), remoteScope: scope });
        fileOps.renameSync = original;
        assert.equal(first.complete, false); assert.equal(calls.length, 0);
        assert.equal(readFileSync(join(f.data, 'chats', '10001.jsonl'), 'utf8'), 'SYNTHETIC_NEW_FACT\n');
        await assert.rejects(forgetContact(f.data, 10002, { ...options(f, fake(calls)), resume: first.jobId, remoteScope: scope }), /不匹配/);
        await assert.rejects(forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: first.jobId, remoteScope: 'b'.repeat(64) }), /不匹配/);
        const again = await forgetContact(f.data, 10001, { ...options(f, fake(calls)), resume: first.jobId, remoteScope: scope });
        assert.equal(again.complete, false); assert.equal(calls.length, 0); assert.ok(again.failures.length > 0);
        assert.equal(readFileSync(join(f.data, 'chats', '10001.jsonl'), 'utf8'), 'SYNTHETIC_NEW_FACT\n');
    } finally { fileOps.renameSync = original; rmSync(f.root, { recursive: true, force: true }); }
});

test('Windows同一目录大小写别名可读取完成任务和恢复原计划，原root及计划摘要不改写', { skip: process.platform !== 'win32' }, async () => {
    const f = fixture();
    try {
        const result = await forgetContact(f.data, 10001, options(f, fake([])));
        const id = result.jobId!, jobPath = join(f.data, 'maintenance', 'forget-jobs', `${id}.json`);
        const original = readFileSync(jobPath, 'utf8'), alias = f.data.toUpperCase();
        assert.notEqual(alias, f.data); assert.equal(existsSync(alias), true);
        assert.deepEqual(unfinishedForgetJobs(alias), []);
        const resumed = await forgetContact(alias, 10001, { ...options(f, fake([])), resume: id });
        assert.equal(resumed.complete, true); assert.equal(resumed.trash, result.trash);
        assert.equal(readFileSync(jobPath, 'utf8'), original);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('断开的维护junction不是缺省空清单，真实lstat链接必须失败关闭且保留原件', () => {
    const f = fixture();
    try {
        const link = join(f.data, 'maintenance');
        symlinkSync(join(f.root, 'nonexistent-target'), link, 'junction');
        assert.equal(existsSync(link), false); assert.equal(lstatSync(link).isSymbolicLink(), true);
        assert.throws(() => unfinishedForgetJobs(f.data), /校验失败/);
        assert.equal(lstatSync(link).isSymbolicLink(), true);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
});
