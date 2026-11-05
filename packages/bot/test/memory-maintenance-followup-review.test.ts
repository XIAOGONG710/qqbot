import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveTestData } from '../src/memory/archive.ts';
import { startApp, type AppOptions } from '../src/platform/app.ts';
import { ARCHIVE_JOBS_DIRECTORY, loadArchiveJob, unfinishedArchiveJobs } from '../src/memory/archive-job.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { WrittenRetainStore } from '../src/memory/written-retain.ts';

function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'qqbot-maintenance-followup-')), data = join(root, 'data'), config = join(root, 'config.json');
 mkdirSync(join(data, 'chats'), { recursive: true });
 writeFileSync(join(data, 'tiers.json'), JSON.stringify({ '10001': 'classmate' }));
 writeFileSync(join(data, 'chats', '10001.jsonl'), '{"role":"user","content":"SYNTHETIC_ARCHIVE_CHAT","time":"2026-11-01T12:00:00Z"}\n');
 writeFileSync(config, JSON.stringify({ memory: { bankPrefix: 'synthetic-old' } }));
 return { root, data, config };
}
function cleanup(root: string) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-maintenance-followup-')); rmSync(root, { recursive: true, force: true }); }

test('archive移动第一份聊天后进程退出，未完成prefix迁移必须继续阻止App业务启动', () => {
 const f = fixture();
 try { const module = new URL('../src/memory/archive.ts', import.meta.url).href, chat = join(f.data, 'chats', '10001.jsonl');
  const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;
   fs.renameSync=(from,to)=>{const result=rename(from,to);if(String(from)===${JSON.stringify(chat)})process.exit(61);return result;};syncBuiltinESMExports();
   const {archiveTestData}=await import(${JSON.stringify(module)});archiveTestData({dataDir:${JSON.stringify(f.data)},configFiles:[${JSON.stringify(f.config)}],prefix:'synthetic-new',now:new Date('2026-11-05T12:00:00Z')});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
  assert.equal(child.error, undefined); assert.equal(child.status, 61, child.stderr); assert.equal(existsSync(chat), false);
  assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).memory.bankPrefix, 'synthetic-old');
  assert.equal(JSON.parse(readFileSync(join(f.data, 'tiers.json'), 'utf8'))['10001'].since, '2026-11-05T12:00:00.000Z');
  let enteredBusiness = false;
  const config = new Proxy({ dataDir: f.data }, { get(target, key) { if (key === 'dataDir') return target.dataDir; enteredBusiness = true; throw Error('SYNTHETIC_BUSINESS_AFTER_INTERRUPTED_ARCHIVE'); } });
  assert.throws(() => startApp({ config, transport: {}, log() {} } as unknown as AppOptions));
  assert.equal(enteredBusiness, false, '中断归档后不能用旧bank前缀越过维护屏障进入业务初始化');
  const [id] = unfinishedArchiveJobs(f.data); assert.ok(id); const job = loadArchiveJob(f.data, id);
  assert.equal(job.complete, false); assert.ok(job.steps.some(step => step.kind === 'replace' && step.target === f.config));
  assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [], prefix: 'another-prefix' }), /未完成归档/);
  assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [], prefix: 'another-prefix', resume: id }), /原前缀/);
  const written = new WrittenRetainStore(join(f.data, 'memory')), intent = written.prepare('synthetic-common', { content: 'SYNTHETIC_PENDING_DIARY', timestamp: '2026-11-01T22:00:00Z',
   document_id: 'diary:2026-11-01', context: '合成', metadata: { source: 'diary' }, tags: ['qq', 'diary'], entities: [] });
  assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [], resume: id }), /未完成日记/); written.phase(intent.operationId, 'completed');
  const unplannedConfig = join(f.root, 'unplanned.json'); writeFileSync(unplannedConfig, '{"memory":{"bankPrefix":"unchanged"}}');
  const result = archiveTestData({ dataDir: f.data, configFiles: [unplannedConfig], resume: id, now: new Date('2027-01-01T00:00:00Z') });
  assert.equal(result.complete, true); assert.equal(result.jobId, id); assert.deepEqual(unfinishedArchiveJobs(f.data), []);
  assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).memory.bankPrefix, 'synthetic-new');
  assert.equal(JSON.parse(readFileSync(unplannedConfig, 'utf8')).memory.bankPrefix, 'unchanged');
  assert.equal(JSON.parse(readFileSync(join(f.data, 'tiers.json'), 'utf8'))['10001'].since, '2026-11-05T12:00:00.000Z');
  assert.equal(written.operation(intent.operationId)!.phase, 'completed');
 } finally { cleanup(f.root); }
});

test('完整计划发布前失败不动业务，已发布后checkpoint错误可精确确认或续原计划', () => {
 for (const mode of ['before-first', 'before-checkpoint', 'after-publish'] as const) {
  const f = fixture(), original = fileOps.renameSync, delays = fileOps.writeDelaysMs; let writes = 0;
  const before = readFileSync(join(f.data, 'tiers.json'), 'utf8');
  try { fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
    if (String(to).replaceAll('\\', '/').includes(`${ARCHIVE_JOBS_DIRECTORY}/`)) {
     writes++;
     if (mode === 'before-first' && writes === 1 || mode === 'before-checkpoint' && writes === 2) throw Error('synthetic before publication');
     if (mode === 'after-publish') { original(from, to); throw Error('synthetic after publication'); }
    } original(from, to);
   };
   if (mode === 'after-publish') assert.equal(archiveTestData({ dataDir: f.data, configFiles: [f.config], prefix: 'synthetic-new' }).complete, true);
   else {
    assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [f.config], prefix: 'synthetic-new' })); fileOps.renameSync = original;
    assert.equal(readFileSync(join(f.data, 'tiers.json'), 'utf8'), before); assert.equal(existsSync(join(f.data, 'chats', '10001.jsonl')), true);
    if (mode === 'before-checkpoint') { const [id] = unfinishedArchiveJobs(f.data); assert.ok(id); assert.equal(archiveTestData({ dataDir: f.data, configFiles: [], resume: id }).complete, true); }
    else assert.deepEqual(unfinishedArchiveJobs(f.data), []);
   }
  } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; cleanup(f.root); }
 }
});

test('恢复时source/target内容冲突与坏final/孤立tmp均保原阻断，不按新计划覆盖', () => {
 const f = fixture(), original = fileOps.renameSync, delays = fileOps.writeDelaysMs; let writes = 0;
 try { fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => {
   if (String(to).replaceAll('\\', '/').includes(`${ARCHIVE_JOBS_DIRECTORY}/`) && ++writes === 2) throw Error('synthetic checkpoint failure'); original(from, to);
  };
  assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [f.config], prefix: 'synthetic-new' })); fileOps.renameSync = original;
  const [id] = unfinishedArchiveJobs(f.data); assert.ok(id); const job = loadArchiveJob(f.data, id), path = join(f.data, ARCHIVE_JOBS_DIRECTORY, `${id}.json`), raw = readFileSync(path, 'utf8');
  const move = job.steps.find(step => step.kind === 'move')!; mkdirSync(dirname(move.target), { recursive: true }); writeFileSync(move.target, 'SYNTHETIC_CONFLICT_TARGET');
  assert.throws(() => archiveTestData({ dataDir: f.data, configFiles: [], resume: id })); assert.equal(readFileSync(move.target, 'utf8'), 'SYNTHETIC_CONFLICT_TARGET'); assert.equal(existsSync(move.source), true);
  writeFileSync(path, '{"SYNTHETIC_PRIVATE_CONFIG":'); assert.throws(() => unfinishedArchiveJobs(f.data), e => !String(e).includes('SYNTHETIC_PRIVATE_CONFIG'));
  assert.equal(readFileSync(path, 'utf8'), '{"SYNTHETIC_PRIVATE_CONFIG":'); writeFileSync(path, raw);
  const tmp = join(f.data, ARCHIVE_JOBS_DIRECTORY, '11111111-1111-4111-8111-111111111111.json.tmp-1-1'); writeFileSync(tmp, 'SYNTHETIC_ORPHAN_INTENT');
  assert.throws(() => unfinishedArchiveJobs(f.data)); assert.equal(readFileSync(tmp, 'utf8'), 'SYNTHETIC_ORPHAN_INTENT');
 } finally { fileOps.renameSync = original; fileOps.writeDelaysMs = delays; cleanup(f.root); }
});

test('archive数据根的父目录是junction时应拒绝，不沿链接归档实际目标', t => {
 const f = fixture(), alias = join(f.root, 'alias');
 try { try { symlinkSync(f.root, alias, 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('host cannot create synthetic junction'); return; } throw error; }
  const through = join(alias, 'data'), original = readFileSync(join(f.data, 'tiers.json'), 'utf8');
  assert.throws(() => archiveTestData({ dataDir: through, configFiles: [f.config], prefix: 'synthetic-new', now: new Date('2026-11-05T12:00:00Z') }));
  assert.equal(readFileSync(join(f.data, 'tiers.json'), 'utf8'), original); assert.equal(existsSync(join(f.data, 'chats', '10001.jsonl')), true);
 } finally { if (existsSync(alias)) rmSync(alias); cleanup(f.root); }
});

test('配置atomic rename前后强制退出均可用CLI续原任务，固定temp和私密配置不外显', () => {
 for (const published of [false, true]) {
  const f = fixture();
  try { writeFileSync(f.config, JSON.stringify({ apiKey: 'SYNTHETIC_CONFIG_SECRET', memory: { bankPrefix: 'synthetic-old' } }));
   const module = new URL('../src/memory/archive.ts', import.meta.url).href;
   const script = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(String(to)===${JSON.stringify(f.config)}){if(${published})rename(from,to);process.exit(62);}return rename(from,to);};syncBuiltinESMExports();
    const{archiveTestData}=await import(${JSON.stringify(module)});archiveTestData({dataDir:${JSON.stringify(f.data)},configFiles:[${JSON.stringify(f.config)}],prefix:'synthetic-new',now:new Date('2026-11-05T12:00:00Z')});`;
   const interrupted = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
   assert.equal(interrupted.error, undefined); assert.equal(interrupted.status, 62, interrupted.stderr); const [id] = unfinishedArchiveJobs(f.data); assert.ok(id);
   assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).memory.bankPrefix, published ? 'synthetic-new' : 'synthetic-old');
   const cli = new URL('../../../scripts/archive-test-data.mjs', import.meta.url);
   const resumed = spawnSync(process.execPath, [fileURLToPath(cli), '--data', f.data, '--resume', id, '--koishi', join(f.root, 'not-the-original-target'), '--no-config'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
   assert.equal(resumed.error, undefined); assert.equal(resumed.status, 0, resumed.stderr); assert.match(resumed.stdout, /归档任务.*已完成/); assert.ok(!resumed.stdout.includes('SYNTHETIC_CONFIG_SECRET'));
   assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).memory.bankPrefix, 'synthetic-new'); assert.deepEqual(unfinishedArchiveJobs(f.data), []);
  } finally { cleanup(f.root); }
 }
});

test('CLI缺少resume UUID不会退化为创建新归档任务', () => {
 const f = fixture();
 try { const cli = new URL('../../../scripts/archive-test-data.mjs', import.meta.url);
  const child = spawnSync(process.execPath, [fileURLToPath(cli), '--data', f.data, '--resume'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024 });
  assert.equal(child.error, undefined); assert.equal(child.status, 2); assert.equal(existsSync(join(f.data, 'chats', '10001.jsonl')), true);
  assert.equal(JSON.parse(readFileSync(f.config, 'utf8')).memory.bankPrefix, 'synthetic-old'); assert.deepEqual(unfinishedArchiveJobs(f.data), []);
 } finally { cleanup(f.root); }
});
