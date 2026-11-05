import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { contextSummarizer } from '../src/language/context-window.ts';
import { jokeStore } from '../src/language/jokes.ts';
import { idiomStore } from '../src/language/idioms.ts';
import { archiveTestData } from '../src/memory/archive.ts';
import { fileOps, writeJsonAtomic } from '../src/memory/json-file.ts';
import { auditContactPrivacy } from '../src/memory/privacy-audit.ts';
import { exportContact, forgetContact } from '../src/memory/privacy-forget.ts';

const now = new Date('2026-11-05T12:00:00Z');
const secret = 'SYNTHETIC_CONTEXT_PRIVATE';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-context-privacy-')), data = join(root, 'bot');
    for (const area of ['context', 'jokes', 'idioms', 'memory']) mkdirSync(join(data, area), { recursive: true });
    const write = (area: string, name: string, text = secret) => { const file = join(data, area, name); writeFileSync(file, text); return file; };
    return { root, data, write, cleanup() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-context-privacy-')); rmSync(root, { recursive: true, force: true }); } };
}

/** Exercise actual producer filenames rather than inventing residue patterns. */
function contextResidues(data: string): string[] {
    const file = join(data, 'context', '10001.json'), original = { ...fileOps };
    try {
        fileOps.writeDelaysMs = [0];
        fileOps.renameSync = () => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); };
        fileOps.unlinkSync = () => { throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EPERM' }); };
        assert.throws(() => writeJsonAtomic(file, { key: 'source-v2:synthetic', text: secret }));
    } finally { Object.assign(fileOps, original); }
    writeFileSync(file, `{"text":"${secret}",`);
    contextSummarizer({ names: { user: '合成甲', char: '合成乙' }, file, log: () => {}, generate: async () => '- 无' }).stop();
    const paths = readdirSync(join(data, 'context')).map(name => join('context', name));
    assert.equal(paths.length, 2); assert.ok(paths.some(path => /\.tmp-\d+-\d+$/.test(path))); assert.ok(paths.some(path => /\.corrupt-\d+$/.test(path)));
    return paths;
}

function lexicalResidues(data: string): string[] {
    const rename = fs.renameSync;
    try {
        fs.renameSync = (() => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EPERM' }); }) as typeof rename;
        syncBuiltinESMExports();
        assert.throws(() => jokeStore({ dir: join(data, 'jokes'), log: () => {} }).save(10001, { version: 1, jokes: [{ phrase: secret, origin: secret }] }));
        assert.throws(() => idiomStore({ dir: join(data, 'idioms'), log: () => {} }).save(10001, { version: 1, items: [{ phrase: secret, kind: '合成习惯', count: 4, days: 2 }] }));
    } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    return [join('jokes', '10001.json.tmp'), join('idioms', '10001.json.tmp')];
}

test('审计精确纳入真实上下文原子失败/隔离及小梗/口头习惯写失败残留', () => {
    const f = fixture();
    try {
        const paths = [...contextResidues(f.data), ...lexicalResidues(f.data)];
        const audit = auditContactPrivacy(f.data, 10001);
        assert.deepEqual(audit.artifacts.filter(item => item.kind === 'direct').map(item => item.path).sort(), paths.sort());
        for (const path of paths) { assert.ok(readFileSync(join(f.data, path), 'utf8').includes(secret)); assert.ok(audit.artifacts.find(item => item.path === path)!.bytes > 0); }
    } finally { f.cleanup(); }
});

test('导出只复制本人的精确残留；他人/相近号码/伪后缀/共享状态不混入', () => {
    const f = fixture();
    try {
        const paths = [...contextResidues(f.data), ...lexicalResidues(f.data)];
        const foreign = ['10002.json.tmp-1-1', '100010.json.corrupt-1', '010001.json.corrupt-1', '10001.json.tmp', '10001.json.tmp-0-1', '10001.json.tmp-1-0', '10001.json.tmp-1-1.bak', '10001.json.corrupt-x', '10001.json.corrupt-1.bak'];
        for (const name of foreign) f.write('context', name);
        for (const area of ['jokes', 'idioms']) for (const name of ['10002.json.tmp', '10001.json.tmp-1-1', '10001.json.tmp.bak', '10001.json.corrupt-1']) f.write(area, name);
        f.write('memory', 'diary.json', JSON.stringify({ text: 'SYNTHETIC_SHARED' }));
        const exported = exportContact(f.data, 10001, join(f.root, 'export'), now);
        assert.deepEqual(exported.files.sort(), paths.sort());
        assert.ok(exported.audit.artifacts.some(item => item.path === join('memory', 'diary.json') && item.kind === 'mixed'));
        for (const path of paths) assert.equal(readFileSync(join(exported.dir, path), 'utf8'), readFileSync(join(f.data, path), 'utf8'));
        assert.equal(existsSync(join(exported.dir, 'memory', 'diary.json')), false);
    } finally { f.cleanup(); }
});

test('遗忘干跑及真实提交/重启恢复均接受残留归属，保留他人与共享文件', async () => {
    const f = fixture();
    try {
        const paths = [...contextResidues(f.data), ...lexicalResidues(f.data)];
        const other = f.write('context', '10002.json.tmp-1-1'), shared = f.write('memory', 'diary.json', JSON.stringify({ text: 'SYNTHETIC_SHARED' }));
        const options = { apply: false, trashDir: join(f.root, 'trash'), commonBank: 'synthetic-common', now, isAlive: () => false };
        const dry = await forgetContact(f.data, 10001, options);
        assert.deepEqual(dry.plan.move.sort(), paths.sort()); assert.equal(dry.applied, false);
        assert.ok(paths.every(path => existsSync(join(f.data, path))));
        const result = await forgetContact(f.data, 10001, { ...options, apply: true });
        assert.equal(result.complete, true); assert.deepEqual(result.failures, []); assert.deepEqual(result.moved.sort(), paths.sort());
        assert.ok(paths.every(path => !existsSync(join(f.data, path)) && readFileSync(join(result.trash!, path), 'utf8').includes(secret)));
        const resumed = await forgetContact(f.data, 10001, { ...options, apply: true, resume: result.jobId });
        assert.equal(resumed.complete, true); assert.deepEqual(resumed.moved.sort(), paths.sort());
        assert.ok(existsSync(other)); assert.ok(existsSync(shared));
    } finally { f.cleanup(); }
});

test('归档保留上下文与词汇缓存策略下，后续审计及遗忘仍覆盖其残留', async () => {
    const f = fixture();
    try {
        const paths = [...contextResidues(f.data), ...lexicalResidues(f.data)];
        const result = archiveTestData({ dataDir: f.data, configFiles: [], prefix: 'synthetic-new', now, isAlive: () => false });
        assert.equal(result.complete, true); assert.ok(paths.every(path => existsSync(join(f.data, path))));
        assert.ok(paths.every(path => auditContactPrivacy(f.data, 10001).artifacts.some(item => item.path === path && item.kind === 'direct')));
        const forgotten = await forgetContact(f.data, 10001, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'synthetic-new-common', now, isAlive: () => false });
        assert.equal(forgotten.complete, true); assert.deepEqual(forgotten.moved.sort(), paths.sort());
    } finally { f.cleanup(); }
});

test('上下文残留目录链接的隐私工具失败关闭，归档不跟随未处理缓存目录', async () => {
    const f = fixture();
    try {
        const outside = join(f.root, 'outside'); mkdirSync(outside); const file = join(outside, '10001.json.tmp-1-1'); writeFileSync(file, secret);
        rmdirSync(join(f.data, 'context')); symlinkSync(outside, join(f.data, 'context'), 'junction');
        assert.throws(() => auditContactPrivacy(f.data, 10001), /链接|范围/);
        assert.throws(() => exportContact(f.data, 10001, join(f.root, 'export'), now), /链接|范围/);
        await assert.rejects(() => forgetContact(f.data, 10001, { apply: true, trashDir: join(f.root, 'trash'), commonBank: 'synthetic-common', now, isAlive: () => false }), /链接|校验|范围/);
        // Archive deliberately does not inspect or move context; it must leave
        // the link and target untouched instead of following this cache directory.
        archiveTestData({ dataDir: f.data, configFiles: [], prefix: 'synthetic-new', now, isAlive: () => false });
        assert.equal(readFileSync(file, 'utf8'), secret);
        assert.throws(() => auditContactPrivacy(f.data, 10001), /链接|范围/);
        rmSync(join(f.data, 'context'));
    } finally { f.cleanup(); }
});
