import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { DerivedState } from '../src/memory/derived-state.ts';
import { fileOps } from '../src/memory/json-file.ts';

const roots: string[] = [];
const A = { qq: 10001, tier: 'boyfriend' }, B = { qq: 10002, tier: 'classmate' };
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'qqbot-derived-')); roots.push(dir); return { dir, path: join(dir, 'derived.json'), store: new DerivedState(dir) }; }
afterEach(() => { for (const dir of roots.splice(0)) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-derived-')); rmSync(dir, { recursive: true, force: true }); } });

test('私人和公共污染批次只发布一次，提交点可同时看见两侧屏障', () => {
    const f = fixture(); f.store.snapshot('private');
    const rename = fileOps.renameSync; let publications = 0;
    try {
        fileOps.renameSync = (from, to) => {
            rename(from, to);
            if (String(to) === f.path) {
                publications++;
                const state = JSON.parse(readFileSync(f.path, 'utf8'));
                assert.deepEqual(Object.keys(state.banks).sort(), ['common', 'private']);
            }
        };
        f.store.markMany([{ bankId: 'private', ...A, documents: ['ep-1'] }, { bankId: 'common', ...A, documents: ['owner:ep-1'] }]);
    } finally { fileOps.renameSync = rename; }
    assert.equal(publications, 1);
    const restarted = new DerivedState(f.dir);
    assert.equal(restarted.snapshot('private').dirty, true); assert.equal(restarted.snapshot('common').dirty, true);
});

test('首次缺省clean；重启保留精确文档且隔离其它bank', () => {
    const f = fixture(); assert.equal(f.store.snapshot('a').dirty, false);
    f.store.mark('a', { ...A, documents: ['ep-1'] });
    const saved = f.store.snapshot('a'); assert.equal(saved.dirty, true); assert.deepEqual(saved.documents, ['ep-1']);
    assert.notEqual(saved.generation, f.store.snapshot('b').generation);
    assert.deepEqual(new DerivedState(f.dir).snapshot('a'), saved); assert.equal(f.store.snapshot('b').dirty, false);
});

test('跨实例fresh合并；未知归属不能被精确文档擦除；入参及结果无别名', () => {
    const f = fixture(), other = new DerivedState(f.dir); other.snapshot('a');
    f.store.mark('a', A); const documents = ['ep-1']; other.mark('a', { ...A, documents }); documents.push('never');
    other.mark('a', { ...B, documents: ['ep-2'] });
    const result = f.store.snapshot('a'); assert.equal(result.owners[0]!.allDocuments, true); assert.deepEqual(result.documents, ['ep-1', 'ep-2']);
    (result.documents as string[]).push('alias'); result.owners[0]!.qq = 999;
    assert.deepEqual(other.snapshot('a').documents, ['ep-1', 'ep-2']); assert.equal(other.snapshot('a').owners[0]!.qq, A.qq);
});

test('坏JSON/schema保原文件并安全失败，不能用RAM覆盖；恢复后补入待发布证据', () => {
    const f = fixture(); f.store.mark('a', { ...A, documents: ['ep-1'] }); const original = readFileSync(f.path, 'utf8');
    for (const bad of ['SECRET_INVALID_JSON', '{"version":1,"banks":{"a":{"generation":"bad","documents":[],"owners":[]}}}']) {
        writeFileSync(f.path, bad); assert.throws(() => f.store.snapshot('a'), error => !String(error).includes('SECRET_INVALID_JSON'));
        assert.throws(() => f.store.mark('a', { ...B, documents: ['ep-2'] })); assert.equal(readFileSync(f.path, 'utf8'), bad);
    }
    writeFileSync(f.path, original); assert.deepEqual(f.store.snapshot('a').documents, ['ep-1', 'ep-2']);
});

test('发布前EIO保磁盘且getter失败关闭；恢复合并他实例新证据', () => {
    const f = fixture(); f.store.mark('a', { ...A, documents: ['ep-1'] }); const original = readFileSync(f.path, 'utf8');
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => { if (String(to) === f.path) throw Object.assign(new Error('SECRET_IO'), { code: 'EIO' }); return rename(from, to); };
        assert.throws(() => f.store.mark('a', { ...A, documents: ['ep-2'] }), /屏障不可用/);
        assert.throws(() => f.store.snapshot('a'), /屏障不可用/); assert.equal(readFileSync(f.path, 'utf8'), original);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    new DerivedState(f.dir).mark('a', { ...B, documents: ['ep-3'] });
    assert.deepEqual(new Set(f.store.snapshot('a').documents), new Set(['ep-1', 'ep-2', 'ep-3']));
});

test('rename已发布后EIO精确确认不误报失败；未知扩展保留而不暴露到snapshot', () => {
    const f = fixture(); f.store.mark('a', A); const parsed = JSON.parse(readFileSync(f.path, 'utf8'));
    parsed.extension = { retained: true }; parsed.banks.a.extension = 2; parsed.banks.a.owners[0].extension = 3; writeFileSync(f.path, JSON.stringify(parsed));
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (from, to) => { rename(from, to); if (String(to) === f.path) throw Object.assign(new Error('SECRET'), { code: 'EIO' }); };
        assert.doesNotThrow(() => f.store.mark('a', { ...A, documents: ['ep-1'] }));
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    const disk = JSON.parse(readFileSync(f.path, 'utf8')); assert.equal(disk.extension.retained, true); assert.equal(disk.banks.a.extension, 2); assert.equal(disk.banks.a.owners[0].extension, 3);
    assert.equal(Object.hasOwn(f.store.snapshot('a').owners[0]!, 'extension'), false);
});

test('原型形状bank身份按字面存取，坏输入不创建私密正文状态', () => {
    const f = fixture(); f.store.mark('__proto__', { ...A, documents: ['constructor'] });
    assert.deepEqual(f.store.snapshot('__proto__').documents, ['constructor']); assert.equal(f.store.snapshot('constructor').dirty, false);
    assert.throws(() => f.store.mark('a', { qq: NaN, tier: 'SECRET' }), error => !String(error).includes('SECRET'));
});

test('初始化必须发布空JSON；曾有状态被删时live与重启均不能猜clean', () => {
    const f = fixture(); assert.equal(f.store.snapshot('a').dirty, false); assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).version, 1);
    f.store.mark('a', A); unlinkSync(f.path);
    assert.throws(() => f.store.snapshot('a'), /屏障不可用/);
    assert.throws(() => new DerivedState(f.dir).snapshot('a'), /屏障不可用/);
    assert.throws(() => new DerivedState(f.dir).mark('a', B), /屏障不可用/);
});

test('首次发布失败留下初始化见证，重启不能宣称clean；已有文件读IO不隔离覆盖', () => {
    const f = fixture(), rename = fileOps.renameSync, read = fileOps.readFileSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = () => { throw Object.assign(new Error('SECRET'), { code: 'EIO' }); };
        assert.throws(() => f.store.snapshot('a'), /屏障不可用/);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
    assert.throws(() => new DerivedState(f.dir).snapshot('a'), /屏障不可用/);
    const good = fixture(); good.store.mark('a', A); const before = readFileSync(good.path, 'utf8');
    try {
        fileOps.readFileSync = ((...args: Parameters<typeof read>) => {
            if (String(args[0]) === good.path) throw Object.assign(new Error('SECRET'), { code: 'EACCES' });
            return Reflect.apply(read, undefined, args);
        }) as typeof read;
        assert.throws(() => good.store.snapshot('a'), error => !String(error).includes('SECRET'));
        assert.throws(() => good.store.mark('a', B), /屏障不可用/);
    } finally { fileOps.readFileSync = read; }
    assert.equal(readFileSync(good.path, 'utf8'), before); assert.equal(good.store.snapshot('a').owners.length, 2);
});

test('独立进程并行mark不覆盖另一进程文档，旧实例刷新可见', async () => {
    const f = fixture(); f.store.snapshot('a');
    const module = new URL('../src/memory/derived-state.ts', import.meta.url).href;
    await Promise.all([1, 2].map(id => new Promise<void>((done, reject) => {
        const code = `import {DerivedState} from ${JSON.stringify(module)};new DerivedState(${JSON.stringify(f.dir)}).mark('a',{qq:${10000 + id},tier:'classmate',documents:['ep-${id}']});`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, timeout: 8000, stdio: ['ignore', 'ignore', 'pipe'] });
        let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { error = (error + text).slice(-4096); });
        child.on('error', reject); child.on('exit', (status, signal) => status === 0 ? done() : reject(new Error(`synthetic child ${status}/${signal}: ${error}`)));
    })));
    assert.deepEqual(new Set(f.store.snapshot('a').documents), new Set(['ep-1', 'ep-2']));
});
