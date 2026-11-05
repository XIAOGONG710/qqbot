import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireLock } from '../src/platform/lock.ts';

const roots: string[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-data-lease-')); roots.push(dir); return { dir, path: join(dir, 'bot.lock') }; }
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-data-lease-')); rmSync(dir, { recursive: true, force: true }); } });
async function until(check: () => boolean) { const end = Date.now() + 5000; while (!check()) { assert.ok(Date.now() < end, 'synthetic timeout'); await new Promise(done => setTimeout(done, 5)); } }

test('检查旧PID后删除前出现新写者，不能删其租约再让两持有者同时成功', () => {
    const f = fixture(); writeFileSync(f.path, String(2 ** 30)); const remove = fs.rmSync;
    let contender: (() => void) | undefined, entered = false, release: (() => void) | undefined;
    fs.rmSync = ((path, options) => {
        if (String(path) === f.path && !entered) {
            entered = true;
            try { contender = acquireLock(f.path); } catch { /* Atomic lease correctly rejects this contender. */ }
        }
        return remove(path, options);
    }) as typeof fs.rmSync;
    syncBuiltinESMExports();
    try { release = acquireLock(f.path); assert.equal(entered, true); assert.equal(contender, undefined, '不能在旧PID比较后被另一写者接管'); }
    finally { fs.rmSync = remove; syncBuiltinESMExports(); release?.(); contender?.(); }
});

test('活OS租约期间PID文件被删或损坏也不允许另一写者接管', () => {
    const f = fixture(), release = acquireLock(f.path);
    try {
        rmSync(f.path); assert.throws(() => acquireLock(f.path, 123, () => false));
        writeFileSync(f.path, 'garbage'); assert.throws(() => acquireLock(f.path, 123, () => false));
    } finally { release(); }
    const next = acquireLock(f.path); next();
});

test('独立进程被强杀释放OS租约，陈旧PID可安全接管且重复release不删新租约', async () => {
    const f = fixture(), module = new URL('../src/platform/lock.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import{acquireLock}from ${JSON.stringify(module)};acquireLock(process.argv[1]);console.log('OWNED');setInterval(()=>{},1000);`, f.path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout!.on('data', chunk => { out += chunk; });
    try {
        await until(() => out.includes('OWNED')); assert.throws(() => acquireLock(f.path));
        child.kill(); await once(child, 'close');
        const first = acquireLock(f.path); first(); const second = acquireLock(f.path);
        try { first(); assert.equal(readFileSync(f.path, 'utf8'), String(process.pid)); } finally { second(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); } }
});

test('损坏协调库不能猜空或覆盖原PID，恢复原文件后可再次取得租约', () => {
    const f = fixture(); writeFileSync(join(f.dir, 'bot.coordination.sqlite'), 'SYNTHETIC_BAD_COORD'); writeFileSync(f.path, String(2 ** 30));
    assert.throws(() => acquireLock(f.path), error => !String(error).includes('SYNTHETIC_BAD_COORD'));
    assert.equal(readFileSync(f.path, 'utf8'), String(2 ** 30)); assert.equal(readFileSync(join(f.dir, 'bot.coordination.sqlite'), 'utf8'), 'SYNTHETIC_BAD_COORD');
});

test('PID发布失败必须释放本次OS租约，恢复路径后不残留同进程busy', () => {
    const f = fixture(), write = fs.writeFileSync;
    fs.writeFileSync = ((path, ...rest) => { if (String(path) === f.path) throw Object.assign(new Error('SYNTHETIC_IO'), { code: 'EIO' }); return (write as Function)(path, ...rest); }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try { assert.throws(() => acquireLock(f.path)); } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    assert.equal(existsSync(f.path), false); const release = acquireLock(f.path); release();
});

test('两独立进程争陈旧PID，在删除前屏障仍只有一份有效OS租约', async () => {
    const f = fixture(), module = new URL('../src/platform/lock.ts', import.meta.url).href;
    writeFileSync(f.path, String(2 ** 30)); const ready = join(f.dir, 'ready'), gate = join(f.dir, 'gate');
    const code = `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{acquireLock}from ${JSON.stringify(module)};
const[path,ready,gate,hold]=process.argv.slice(1),remove=fs.rmSync;
if(hold==='first'){let once=false;fs.rmSync=(p,o)=>{if(String(p)===path&&!once){once=true;fs.writeFileSync(ready,'ready');const end=Date.now()+5000;while(!fs.existsSync(gate)){if(Date.now()>end)throw Error('timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return remove(p,o)};syncBuiltinESMExports();}
try{acquireLock(path);console.log('OWNED');setInterval(()=>{},1000)}catch{console.log('BUSY');process.exitCode=0}`;
    const first = spawn(process.execPath, ['--input-type=module', '-e', code, f.path, ready, gate, 'first'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let firstOut = ''; first.stdout!.on('data', value => { firstOut += value; }); let second: ReturnType<typeof spawn> | undefined;
    try {
        await until(() => existsSync(ready));
        second = spawn(process.execPath, ['--input-type=module', '-e', code, f.path, ready, gate, 'second'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let secondOut = ''; second.stdout!.on('data', value => { secondOut += value; });
        await until(() => /BUSY|OWNED/.test(secondOut));
        assert.match(secondOut, /BUSY/); writeFileSync(gate, 'go'); await until(() => firstOut.includes('OWNED'));
    } finally {
        writeFileSync(gate, 'go');
        for (const child of [first, second]) if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); }
    }
});
