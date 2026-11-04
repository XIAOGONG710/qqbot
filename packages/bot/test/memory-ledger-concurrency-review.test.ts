import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ledger, LedgerWriteError } from '../src/memory/ledger.ts';
const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/memory/ledger.ts')).href;
const at = new Date('2026-11-05T12:00:00Z');
function worker(code: string, args: string[]) {
 let child!: ReturnType<typeof execFile>;
 const done = new Promise<void>((resolve, reject) => {
  child = execFile(process.execPath, ['--input-type=module', '-e', code, ...args], { timeout: 6000, maxBuffer: 1024 * 1024 }, error => error ? reject(error) : resolve());
 });
 return { child, done };
}

test('两个独立写者只在明确busy时重试，成功追加全部保留且重启链有效', { timeout: 15_000 }, async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-ledger-process-')); const path = join(dir, 'ledger.jsonl');
 const code = `import {Ledger,LedgerWriteError} from ${JSON.stringify(moduleUrl)};const ledger=new Ledger(process.argv[1]);for(let i=0;i<12;i++){const end=Date.now()+4000;for(;;){try{ledger.append('worker',{worker:process.argv[2],i});break;}catch(e){if(!(e instanceof LedgerWriteError)||!e.retryable||Date.now()>end)throw e;await new Promise(r=>setTimeout(r,5));}}await new Promise(r=>setTimeout(r,1));}`;
 const workers: ReturnType<typeof worker>[] = [];
 try {
  const ledger = new Ledger(path); ledger.append('seed', {}, at);
  workers.push(worker(code, [path, 'a']), worker(code, [path, 'b']));
  const settled = await Promise.allSettled(workers.map(value => value.done)); for (const result of settled) assert.equal(result.status, 'fulfilled');
  assert.deepEqual(ledger.verify(), { ok: true, count: 25 });
  assert.equal(new Set(ledger.read().slice(1).map(entry => `${entry.data.worker}:${entry.data.i}`)).size, 24);
 } finally { for (const value of workers) value.child.kill('SIGKILL'); await Promise.allSettled(workers.map(value => value.done)); rmSync(dir, { recursive: true, force: true }); }
});

test('追加完整后报错可确认本次结果，半行失败保留断点而不被下一次追加抹除', () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-ledger-append-fault-')); const original = fs.appendFileSync;
 try {
  const complete = new Ledger(join(dir, 'complete.jsonl')); complete.append('seed', {}, at);
  fs.appendFileSync = ((...args: Parameters<typeof original>) => { original(...args); throw new Error('synthetic after append'); }) as typeof original; syncBuiltinESMExports();
  assert.doesNotThrow(() => complete.append('next', {}, at)); assert.deepEqual(complete.verify(), { ok: true, count: 2 });
  fs.appendFileSync = original; syncBuiltinESMExports();
  const partial = new Ledger(join(dir, 'partial.jsonl')); partial.append('seed', {}, at);
  fs.appendFileSync = ((path: fs.PathOrFileDescriptor) => { original(path, '{partial'); throw new Error('synthetic partial'); }) as typeof original; syncBuiltinESMExports();
  assert.throws(() => partial.append('next', {}, at));
  fs.appendFileSync = original; syncBuiltinESMExports();
  const broken = readFileSync(partial.path, 'utf8'); assert.equal(partial.verify().ok, false);
  assert.throws(() => partial.append('must-not-heal', {}, at)); assert.equal(readFileSync(partial.path, 'utf8'), broken);
 } finally { fs.appendFileSync = original; syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('head原子发布后异常按成功返回，发布前失败保守拒写且不自动修复', () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-ledger-head-fault-')); const original = fs.renameSync;
 try {
  for (const after of [false, true]) {
   const ledger = new Ledger(join(dir, String(after) + '.jsonl')); ledger.append('seed', {}, at);
   fs.renameSync = ((from, to) => { if (String(to) === `${ledger.path}.head`) { if (after) original(from, to); throw new Error('synthetic head publish'); } original(from, to); }) as typeof original; syncBuiltinESMExports();
   if (after) assert.doesNotThrow(() => ledger.append('next', {}, at)); else assert.throws(() => ledger.append('next', {}, at));
   fs.renameSync = original; syncBuiltinESMExports();
   assert.equal(ledger.verify().ok, after);
   if (!after) { const data = readFileSync(ledger.path, 'utf8'); assert.throws(() => ledger.append('no-auto-repair', {}, at)); assert.equal(readFileSync(ledger.path, 'utf8'), data); }
  }
 } finally { fs.renameSync = original; syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});

test('写JSONL后head发布前进程被强杀，锁释放但断链不自动恢复或覆盖', { timeout: 15_000 }, async () => {
 const dir = mkdtempSync(join(tmpdir(), 'qqbot-ledger-crash-')); const path = join(dir, 'ledger.jsonl'); const point = join(dir, 'checkpoint');
 const code = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {Ledger} from ${JSON.stringify(moduleUrl)};const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to)===process.argv[1]+'.head'){fs.writeFileSync(process.argv[2],'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,4000);throw Error('checkpoint expired');}return rename(from,to)};syncBuiltinESMExports();new Ledger(process.argv[1]).append('crash',{});`;
 let task: ReturnType<typeof worker> | undefined;
 try {
  const ledger = new Ledger(path); ledger.append('seed', {}, at); const head = readFileSync(`${path}.head`, 'utf8');
  task = worker(code, [path, point]); const finished = task.done.catch(() => undefined);
  const deadline = Date.now() + 4000;
  while (!existsSync(point)) { assert.ok(Date.now() < deadline, 'crash checkpoint not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
  task.child.kill('SIGKILL'); await finished;
  assert.equal(ledger.verify().ok, false); assert.equal(readFileSync(`${path}.head`, 'utf8'), head);
  assert.throws(() => ledger.append('must-not-heal', {}, at), error => error instanceof LedgerWriteError && !error.retryable);
 } finally { task?.child.kill('SIGKILL'); if (task) await task.done.catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});
